import {Log} from 'json-joy/lib/json-crdt/log/Log';
import {Model, Patch} from 'json-joy/lib/json-crdt';
import {concurrency} from 'thingies/lib/concurrencyDecorator';
import {createRace} from 'thingies/lib/createRace';
import {SESSION} from 'json-joy/lib/json-crdt-patch/constants';
import {Subject} from 'rxjs';
import {first, takeUntil} from 'rxjs/operators';
import type {
  BlockId,
  LocalRepo,
  LocalRepoDeleteEvent,
  LocalRepoEvent,
  LocalRepoMergeEvent,
  LocalRepoRebaseEvent,
  LocalRepoResetEvent,
} from '../local/types';

export class EditSession {
  public log: Log;
  protected _stopped = false;
  protected _stop$ = new Subject<void>();
  public onsyncerror?: (error: Error | unknown) => void;
  private _syncRace = createRace();

  public get model(): Model {
    return this.log.end;
  }

  constructor(
    public readonly repo: LocalRepo,
    public readonly id: BlockId,
    protected start: Model,
    public cursor: undefined | unknown = undefined,
    protected readonly session: number = Math.floor(Math.random() * 0x7fffffff),
  ) {
    this.log = new Log(() => this.start.clone());
    const flushUnsubscribe = this.log.end.api.onFlush.listen((a) => {
      this.syncLog();
    });
    this._stop$.pipe(first()).subscribe(() => {
      flushUnsubscribe();
    });
    this.repo.change$(this.id).pipe(takeUntil(this._stop$)).subscribe(this.onEvent);
  }

  public dispose(): void {
    if (this._stopped) return;
    this._stopped = true;
    this._stop$.next();
  }

  protected clear(): void {
    const {start, log} = this;
    const empty = Model.create(undefined, start.clock.sid);
    start.reset(empty);
    log.patches.clear();
    log.end.reset(empty);
  }

  private saveInProgress = false;

  /**
   * Push (persist) any in-memory changes and pull (load) the latest state
   * from the local repo.
   */
  @concurrency(1) public async sync(): Promise<null | {remote?: Promise<void>}> {
    if (this._stopped) return null;
    const log = this.log;
    const api = log.end.api;
    api.flush();
    this.saveInProgress = true;
    try {
      const patches: Patch[] = [];
      log.patches.forEach((patch) => {
        patches.push(patch.v);
      });
      const length = patches.length;
      // TODO: After async call check that sync state is still valid. New patches, might have been added.
      if (length || this.cursor === undefined) {
        const res = await this.repo.sync({id: this.id, patches, cursor: this.cursor, session: this.session});
        if (this._stopped) return null;
        // TODO: After sync call succeeds, remove the patches from the log.
        if (length) {
          const last = patches[length - 1];
          const lastId = last.getId();
          if (lastId) this.log.advanceTo(lastId);
          this.start.applyBatch(patches);
        }
        if (typeof res.cursor !== undefined) this.cursor = res.cursor;
        if (res.model) {
          this._syncRace(() => {
            this.reset(res.model!);
          });
        } else if (res.merge) {
          this._syncRace(() => {
            this.merge(res.merge!);
          });
        }
        return {remote: res.remote};
      } else {
        const res = await this.repo.getIf({id: this.id, time: this.model.clock.time - 1, cursor: this.cursor});
        if (this._stopped) return null;
        if (res) {
          this.reset(res.model);
          this.cursor = res.cursor;
        }
        return null;
      }
    } finally {
      this.saveInProgress = false;
      this.drainEvents();
    }
  }

  public syncLog(): void {
    if (!this.log.patches.size()) return;
    this.sync().then((error) => {
      this.onsyncerror?.(error);
    });
  }

  public async del(): Promise<void> {
    this.clear();
    this.dispose();
    await this.repo.del(this.id);
  }

  /**
   * Load latest state from the local repo.
   */
  public async load(): Promise<void> {
    const {model} = await this.repo.get({id: this.id});
    if (model.clock.time > this.start.clock.time) this.reset(model);
  }

  public loadSilent(): void {
    this.load().catch(() => {});
  }

  // ------------------------------------------------------- change integration

  protected reset(model: Model): void {
    this.start = model.clone();
    const log = this.log;
    const end = log.end;
    if (end.api.builder.patch.ops.length) end.api.flush();
    end.reset(model);
    log.patches.forEach((patch) => end.applyPatch(patch.v));
  }

  protected rebase(patches: Patch[]): void {
    if (patches.length === 0) return;
    const log = this.log;
    const end = log.end;
    if (end.api.builder.patch.ops.length) end.api.flush();
    if (log.patches.size() === 0) {
      this.merge(patches);
      return;
    }
    this.start.applyBatch(patches);
    const newEnd = this.start.clone();
    const lastPatch = patches[patches.length - 1];
    let nextTick = lastPatch.getId()!.time + lastPatch.span();
    const rebased: Patch[] = [];
    log.patches.forEach(({v}) => {
      const patch = v.rebase(nextTick);
      rebased.push(patch);
      newEnd.applyPatch(patch);
      nextTick += patch.span();
    });
    log.patches.clear();
    for (const patch of rebased) log.patches.set(patch.getId()!, patch);
    log.end.reset(newEnd);
  }

  protected merge(patches: Patch[]): void {
    if (!patches.length) return;
    const start = this.start;
    const log = this.log;
    const end = log.end;
    const sid = end.clock.sid;
    for (const patch of patches) {
      const patchId = patch.getId();
      if (!patchId) continue;
      const patchSid = patchId.sid;
      if (patchSid === SESSION.GLOBAL) continue;
      if (patchSid === sid && patchId.time < end.clock.time) continue;
      end.applyPatch(patch);
      start.applyPatch(patch);
      log.patches.del(patchId);
    }
  }

  // ------------------------------------------------ reactive event processing

  private events: LocalRepoEvent[] = [];

  private onEvent = (event: LocalRepoEvent): void => {
    if (this._stopped) return;
    if ((event as LocalRepoRebaseEvent).rebase) {
      if ((event as LocalRepoRebaseEvent).session === this.session) return;
    }
    this.events.push(event);
    this.drainEvents();
  };

  private drainEvents(): void {
    if (this.saveInProgress || this._stopped) return;
    this._syncRace(() => {
      const events = this.events;
      const length = events.length;
      for (let i = 0; i < length; i++) {
        const event = events[i];
        try {
          if ((event as LocalRepoResetEvent).reset) this.reset((event as LocalRepoResetEvent).reset);
          else if ((event as LocalRepoRebaseEvent).rebase) this.rebase((event as LocalRepoRebaseEvent).rebase);
          else if ((event as LocalRepoMergeEvent).merge) this.merge((event as LocalRepoMergeEvent).merge);
          else if ((event as LocalRepoDeleteEvent).del) {
            this.clear();
            break;
          }
        } catch (error) {
          // tslint:disable-next-line no-console
          console.error('Failed to apply event', event, error);
        }
      }
      this.events = [];
    });
  }
}
