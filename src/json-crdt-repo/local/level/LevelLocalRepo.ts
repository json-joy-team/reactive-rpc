import {BehaviorSubject, defer, Observable, type Subscription} from 'rxjs';
import {catchError, filter, finalize, map, share, switchMap, tap} from 'rxjs/operators';
import {gzip, ungzip} from '@jsonjoy.com/util/lib/compression/gzip';
import {Writer} from '@jsonjoy.com/util/lib/buffers/Writer';
import {CborJsonValueCodec} from '@jsonjoy.com/json-pack/lib/codecs/cbor';
import {Model, Patch} from 'json-joy/lib/json-crdt';
import {deepEqual} from 'json-joy/lib/json-equal/deepEqual';
import {SESSION} from 'json-joy/lib/json-crdt-patch/constants';
import {once} from 'thingies/lib/once';
import {timeout} from 'thingies/lib/timeout';
import {pubsub} from '../../pubsub';
import type {ServerBatch, ServerHistory, ServerPatch} from '../../remote/types';
import type {BlockId, LocalRepo, LocalRepoEvent, LocalRepoDeleteEvent, LocalRepoMergeEvent, LocalRepoRebaseEvent, LocalRepoResetEvent, LocalRepoSyncRequest, LocalRepoSyncResponse, LocalRepoGetResponse, LocalRepoGetRequest, LocalRepoCreateResponse, LocalRepoCreateRequest} from '../types';
import type {BinStrLevel, BinStrLevelOperation, BlockMeta, LocalBatch, SyncResult, LevelLocalRepoPubSub, LevelLocalRepoCursor} from './types';
import type {CrudLocalRepoCipher} from './types';
import type {Locks} from 'thingies/lib/Locks';
import type {JsonValueCodec} from '@jsonjoy.com/json-pack/lib/codecs/types';

/**
 * @todo
 * 
 * 1. Implement pull loop, when WebSocket subscription cannot be established.
 */

const enum Defaults {
  /**
   * The root of the block repository.
   * 
   * ```
   * b!<collection>!<id>!
   * ```
   */
  BlockRepoRoot = 'b',

  /**
   * The root of the key-space where items are marked as "dirty" and need sync.
   * 
   * ```
   * s!<collection>!<id>
   * ```
   */
  SyncRoot = 's',

  /**
   * The metadata of the block.
   * 
   * ```
   * b!<collection>!<id>!k!x
   * ```
   */
  Metadata = 'k!x',

  /**
   * The state of the latest known server-side model.
   * 
   * ```
   * b!<collection>!<id>!k!m
   * ```
   */
  Model = 'k!m',

  /**
   * List of frontier patches.
   * 
   * ```
   * b!<collection>!<id>!f!<time>
   * ```
   */
  Frontier = 'f',

  /**
   * List of batches verified by the server.
   * 
   * ```
   * b!<collection>!<id>!h!<seq>
   * ```
   */
  Batches = 'h',

  /**
   * List of snapshots.
   * 
   * ```
   * b!<collection>!<id>!s!<seq>
   * ```
   */
  Snapshots = 's',

  /**
   * The default length of the history, if `hist` metadata property not
   * specified.
   */
  HistoryLength = 100,
}

export interface LevelLocalRepoOpts {
  /**
   * Session ID of the user on this device. The same session ID is reused across
   * all tabs.
   */
  readonly sid: number;

  /**
   * Local persistance LevelDB API.
   */
  readonly kv: BinStrLevel;

  /**
   * Optional content encryption/decryption API.
   */
  readonly cipher?: CrudLocalRepoCipher;
  
  /**
   * Cross-tab locking API.
   */
  readonly locks: Locks;

  /**
   * Optional observable that emits `true` when the device is connected to the
   * server and `false` when it's not.
   */
  readonly connected$?: BehaviorSubject<boolean>;

  /**
   * RPC API for communication with the server.
   */
  readonly rpc: ServerHistory;

  /**
   * Event bus.
   */
  readonly pubsub?: LevelLocalRepoPubSub;

  /**
   * Number of milliseconds after which remote calls are considered timed out.
   */
  readonly remoteTimeout?: number;

  /**
   * Minimum backoff time in milliseconds for the sync loop.
   */
  readonly syncLoopMinBackoff?: number;

  /**
   * Maximum backoff time in milliseconds for the sync loop.
   */
  readonly syncLoopMaxBackoff?: number;
}

export class LevelLocalRepo implements LocalRepo {
  readonly kv: BinStrLevel;
  public readonly locks: Locks;
  public readonly sid: number;
  public readonly connected$: BehaviorSubject<boolean>;
  protected readonly pubsub: LevelLocalRepoPubSub;
  protected readonly cipher?: CrudLocalRepoCipher;
  protected readonly codec: JsonValueCodec = new CborJsonValueCodec(new Writer(1024 * 16));

  constructor(protected readonly opts: LevelLocalRepoOpts) {
    this.kv = opts.kv;
    this.locks = opts.locks;
    this.sid = opts.sid;
    this.connected$ = opts.connected$ ?? new BehaviorSubject(true);
    this.pubsub = opts.pubsub ?? pubsub('level-local-repo');
    this.cipher = opts.cipher;
  }

  private _conSub: Subscription | undefined = undefined;

  @once
  public start(): void {
    this._conSub = this.connected$.subscribe((connected) => {
      if (connected) {
        this.syncAll().catch(() => {});
      } else {
      }
    });
  }

  @once
  public stop(): void {
    this._conSub?.unsubscribe();
  }

  protected async encrypt(blob: Uint8Array, zip: boolean): Promise<Uint8Array> {
    // if (zip) blob = await gzip(blob);
    // if (this.cipher) blob = await this.cipher.encrypt(blob);
    return blob;
  }

  protected async decrypt(blob: Uint8Array, zip: boolean): Promise<Uint8Array> {
    // if (this.cipher) blob = await this.cipher.decrypt(blob);
    // if (zip) blob = await ungzip(blob);
    return blob;
  }

  protected async encode(value: unknown, zip: boolean): Promise<Uint8Array> {
    const encoded = this.codec.encoder.encode(value);
    const encrypted = await this.encrypt(encoded, zip);
    return encrypted;
  }

  protected async decode(blob: Uint8Array, zip: boolean): Promise<unknown> {
    const decrypted = await this.decrypt(blob, zip);
    const decoded = this.codec.decoder.decode(decrypted);
    return decoded;
  }

  /** @todo Encrypt collection and key. */
  public async blockKeyBase(id: BlockId): Promise<string> {
    return Defaults.BlockRepoRoot + '!' + id.join('!') + '!';
  }

  public frontierKeyBase(blockKeyBase: string): string {
    return blockKeyBase + Defaults.Frontier + '!';
  }

  public frontierKey(blockKeyBase: string, time: number): string {
    const timeFormatted = time.toString(36).padStart(8, '0');
    return this.frontierKeyBase(blockKeyBase) + timeFormatted;
  }

  public batchKeyBase(blockKeyBase: string): string {
    return blockKeyBase + Defaults.Batches + '!';
  }

  public batchKey(blockKeyBase: string, seq: number): string {
    const seqFormatted = seq.toString(36).padStart(8, '0');
    return this.batchKeyBase(blockKeyBase) + seqFormatted;
  }

  public snapshotKeyBase(blockKeyBase: string): string {
    return blockKeyBase + Defaults.Snapshots + '!';
  }

  public snapshotKey(blockKeyBase: string, seq: number): string {
    const seqFormatted = seq.toString(36).padStart(8, '0');
    return this.snapshotKeyBase(blockKeyBase) + seqFormatted;
  }

  protected async _exists(keyBase: string): Promise<boolean> {
    const metaKey = keyBase + Defaults.Metadata;
    const exists = (await this.kv.keys({gte: metaKey, lte: metaKey, limit: 1}).all()).length > 0;
    return exists;
  }

  protected _modelWrOp(keyBase: string, model: Uint8Array): Promise<BinStrLevelOperation> {
    return this.encode(model, true).then((value) => ({
      type: 'put',
      key: keyBase + Defaults.Model,
      value,
    } as BinStrLevelOperation));
  }

  protected _metaWrOp(keyBase: string, meta?: BlockMeta): Promise<BinStrLevelOperation> {
    return this.encode(meta, false).then((value) => ({
      type: 'put',
      key: keyBase + Defaults.Metadata,
      value,
    } as BinStrLevelOperation));
  }

  protected async _modelWrOps(keyBase: string, model: Uint8Array, meta?: BlockMeta): Promise<BinStrLevelOperation[]> {
    const ops: Promise<BinStrLevelOperation>[] = [this._modelWrOp(keyBase, model)];
    if (meta) ops.push(this._metaWrOp(keyBase, meta));
    return Promise.all(ops);
  }

  protected async _wrModel(keyBase: string, model: Uint8Array, meta?: BlockMeta): Promise<void> {
    const ops = await this._modelWrOps(keyBase, model, meta);
    await this.kv.batch(ops);
  }

  protected async load(id: BlockId): Promise<{model: Model}> {
    const blockId = id.join('/');
    const res = await this.opts.rpc.read(blockId);
    const block = res.block;
    const snapshot = block.snapshot;
    const seq = snapshot.seq;
    const sid = this.sid;
    const model = Model.load(snapshot.blob, sid);
    for (const batch of block.tip)
      for (const patch of batch.patches)
        model.applyPatch(Patch.fromBinary(patch.blob));
    const keyBase = await this.blockKeyBase(id);
    const metaKey = keyBase + Defaults.Metadata;
    const meta: BlockMeta = {
      time: -1,
      seq,
    };
    const modelBlob = model.toBinary();
    const [metaBlob, modelTupleBlob] = await Promise.all([
      this.encode(meta, false),
      this.encode(modelBlob, true),
    ]);
    const ops: BinStrLevelOperation[] = [
      {
        type: 'put',
        key: metaKey,
        value: metaBlob,
      },
      {
        type: 'put',
        key: keyBase + Defaults.Model,
        value: modelTupleBlob,
      },
    ];
    await this.lockBlock(keyBase, async () => {
      const exists = await this._exists(keyBase);
      if (exists) throw new Error('EXISTS');
      await this.kv.batch(ops);
    });
    // TODO: Emit something here...
    // this.pubsub.pub(['pull', {id, batches: [], snapshot: {seq, blob: modelBlob}}])
    return {model};
  }

  protected async readMeta(keyBase: string): Promise<BlockMeta> {
    const metaKey = keyBase + Defaults.Metadata;
    const blob = await this.kv.get(metaKey);
    const meta = this.codec.decoder.decode(blob) as BlockMeta;
    return meta;
  }

  public async readModel0(keyBase: string): Promise<Uint8Array> {
    const modelKey = keyBase + Defaults.Model;
    const blob = await this.kv.get(modelKey);
    const decoded = await this.decode(blob, true) as Uint8Array;
    return decoded;
  }

  public async readModel(keyBase: string): Promise<Model> {
    try {
      const blob = await this.readModel0(keyBase);
      const model = Model.load(blob, this.sid);
      return model;
    } catch (error) {
      if (!!error && typeof error === 'object' && (error as any).code === 'LEVEL_NOT_FOUND')
        throw new Error('NOT_FOUND')
      throw error;
    }
  }

  public async *readFrontierBlobs0(keyBase: string) {
    const gt = this.frontierKeyBase(keyBase);
    const lt = gt + '~';
    for await (const [key, buf] of this.kv.iterator({gt, lt})) {
      /** @todo Remove this conversion once json-pack supports Buffers. */
      const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      yield [key, uint8] as const;
    }
  }

  public async readFrontier0(keyBase: string): Promise<Patch[]> {
    const patches: Patch[] = [];
    for await (const [, blob] of this.readFrontierBlobs0(keyBase)) {
      const patch = Patch.fromBinary(blob);
      patches.push(patch);
    }
    return patches;
  }

  public async readFrontierTip(keyBase: string): Promise<Patch | undefined> {
    const frontierBase = this.frontierKeyBase(keyBase);
    const lte = frontierBase + `~`;
    for await (const blob of this.kv.values({lte, limit: 1, reverse: true})) return Patch.fromBinary(blob);
    return;
  }

  protected async lockBlock<T>(keyBase: string, fn: () => Promise<T>): Promise<T> {
    return await this.locks.lock(keyBase, 500, 500)<T>(fn);
  }

  // ---------------------------------------------------------- Synchronization

  protected async markDirty(id: BlockId): Promise<void> {
    const key = Defaults.SyncRoot + '!' + id.join('!');
    const blob = this.codec.encoder.encode(Date.now());
    await this.kv.put(key, blob);
  }

  protected async markDirtyAndSync(id: BlockId): Promise<boolean> {
    this.markDirty(id).catch(() => {});
    return await this.push(id);
  }

  protected remoteTimeout(): number {
    return this.opts.remoteTimeout ?? 5000;
  }

  /**
   * Pushes to remote.
   */
  protected async push(id: BlockId, doPull: boolean = false): Promise<boolean> {
    if (!this.connected$.getValue()) throw new Error('DISCONNECTED');
    const keyBase = await this.blockKeyBase(id);
    const remote = this.opts.rpc;
    const remoteId = id.join('/');
    const patches: ServerPatch[] = [];
    const syncMarkerKey = Defaults.SyncRoot + '!' + id.join('!');
    const ops: BinStrLevelOperation[] = [{type: 'del', key: syncMarkerKey}];
    const encoder = this.codec.encoder;
    for await (const [key, blob] of this.readFrontierBlobs0(keyBase)) {
      ops.push({type: 'del', key});
      patches.push({blob});
    }
    if (!patches && !doPull) return false;
    // TODO: handle case when this times out, but actually succeeds, so on re-sync it handles the case when the block is already synced.
    return await this.lockBlock(keyBase, async () => {
      const TIMEOUT = this.remoteTimeout();
      const startTime = Date.now();
      const assertTimeout = () => {
        if (Date.now() - startTime > TIMEOUT) throw new Error('TIMEOUT');
      };
      return await timeout(TIMEOUT, async () => {
        const read = await Promise.all([
          this.readModel(keyBase),
          this.readMeta(keyBase),
        ]);
        assertTimeout();
        let model = read[0];
        const meta = read[1];
        // TODO: Track some meta to avoid unnecessary syncs.
        // if (Date.now() - meta.ts < 1000) return false;
        const hist = !!meta.hist;
        const lastKnownSeq = meta.seq;
        const response = await remote.update(remoteId, {patches}, lastKnownSeq);
        assertTimeout();
        // TODO: handle case when block is deleted on the server.
        // Process pull
        const pull = response.pull;
        if (pull) {
          const snapshot = pull.snapshot;
          const batches = pull.batches;
          if (snapshot) {
            model = Model.load(snapshot.blob, this.sid);
            if (hist) {
              ops.push({
                type: 'put',
                key: this.snapshotKey(keyBase, snapshot.seq),
                value: await this.encode(snapshot, true),
              });
              assertTimeout();
            }
          }
          if (batches) {
            for (const b of batches) {
              const patches = b.patches;
              for (const patch of patches) model.applyPatch(Patch.fromBinary(patch.blob));
              if (hist) {
                ops.push({
                  type: 'put',
                  key: this.batchKey(keyBase, b.seq),
                  value: await this.encode(b, false),
                });
                assertTimeout();
              }
            }
          }
        }
        // Process the latest batch
        for (const patch of patches) model.applyPatch(Patch.fromBinary(patch.blob));
        const batch: LocalBatch = {...response.batch, patches};
        const seq = batch.seq;
        if (hist) {
          ops.push({
            type: 'put',
            key: this.batchKey(keyBase, seq),
            value: await this.encode(batch, false),
          });
          assertTimeout();
        }
        // Process the model and metadata
        meta.time = model.clock.time - 1;
        meta.seq = seq;
        const modelOps = await this._modelWrOps(keyBase, model.toBinary(), meta);
        assertTimeout();
        ops.push(...modelOps);
        await this.kv.batch(ops);
        if (pull) {
          // const data: LevelLocalRepoRemotePull = {
          //   id,
          //   batch,
          //   batches: pull.batches,
          //   snapshot: pull.snapshot
          // };
          // TODO: Emit something here...
          // this.pubsub.pub(['pull', data]);
        }
        return true;
      });
    });
  }

  public async isDirty(collection: string[], id: string): Promise<boolean> {
    throw new Error('not implemented');
    // const dir = ['sync', 'dirty', ...collection];
    // try {
    //   await this.core.crud.info(dir, id);
    //   return true;
    // } catch (error) {
    //   if (error instanceof DOMException && error.name === 'ResourceNotFound') return false;
    //   throw error;
    // }
  }

  protected async *listDirty(collection: string[] = ['sync', 'dirty']): AsyncIterableIterator<BlockId> {
    throw new Error('not implemented');
    // for await (const entry of this.core.crud.scan(collection)) {
    //   if (entry.type === 'collection') yield* this.listDirty([...collection, entry.id]);
    //   else yield {collection, id: entry.id};
    // }
  }

  protected async *syncDirty(): AsyncIterableIterator<SyncResult> {
    // for await (const block of this.listDirty()) {
    //   const {
    //     collection: [_sync, _dirty, ...collection],
    //     id,
    //   } = block;
    //   try {
    //     const success = await this.sync(collection, id);
    //     yield [block, success];
    //   } catch (error) {
    //     yield [block, false, error];
    //   }
    // }
  }

  public async syncAll(): Promise<SyncResult[]> {
    throw new Error('not implemented');
    // const locks = this.locks;
    // if (locks.isLocked('sync')) return [];
    // const list: SyncResultList = [];
    // const duration = 30000;
    // const start = Date.now();
    // return await locks.lock(
    //   'sync',
    //   duration,
    //   3000,
    // )(async () => {
    //   for await (const result of this.syncDirty()) {
    //     if (!this.core.connected$.getValue()) return [];
    //     list.push(result);
    //     const now = Date.now();
    //     if (now - start + 100 > duration) break;
    //   }
    //   return list;
    // });
  }

  /** ----------------------------------------------------- {@link LocalRepo} */

  public async create({id, patches}: LocalRepoCreateRequest): Promise<LocalRepoCreateResponse> {
    const keyBase = await this.blockKeyBase(id);
    const meta: BlockMeta = {
      time: -1,
      seq: -1,
    };
    const ops: BinStrLevelOperation[] = [];
    const model = Model.create(void 0, this.sid);
    if (patches && patches.length) {
      for (const patch of patches) {
        const patchId = patch.getId();
        if (!patchId) throw new Error('PATCH_ID_MISSING');
        model.applyPatch(patch);
        const patchKey = this.frontierKey(keyBase, patchId.time);
        const op: BinStrLevelOperation = {
          type: 'put',
          key: patchKey,
          value: patch.toBinary(),
        };
        ops.push(op);
      }
    }
    ops.push(...await this._modelWrOps(keyBase, model.toBinary(), meta));
    await this.lockBlock(keyBase, async () => {
      const exists = await this._exists(keyBase);
      if (exists) throw new Error('EXISTS');
      await this.kv.batch(ops);
    });
    const remote = this.markDirtyAndSync(id).then(() => {});
    remote.catch(() => {});
    return {model, remote};
  }

  public async get({id, remote}: LocalRepoGetRequest): Promise<LocalRepoGetResponse> {
    try {
      const {model} = await this._syncRead(id);
      if (!model) throw new Error('NOT_FOUND');
      return {model};
    } catch (error) {
      if (remote && error instanceof Error && error.message === 'NOT_FOUND')
        return await this.load(id);
      throw error;
    }
  }

  public async sync(req: LocalRepoSyncRequest): Promise<LocalRepoSyncResponse> {
    const cursor = req.cursor as LevelLocalRepoCursor | undefined;
    const {id, patches, throwIf} = req;
    const isNewSession = !Array.isArray(cursor);
    const isCreate = !!patches;
    const isWrite = !!patches && patches.length !== 0;
    if (isNewSession) {
      if (isWrite) {
        try {
          return await this._syncCreate(req);
        } catch (error) {
          if (error instanceof Error && error.message === 'EXISTS')
              return await this._syncRebaseAndMerge(req);
          throw error;
        }
      } else if (isCreate) {
        try {
          return await this._syncCreate(req);
        } catch (error) {
          if (error instanceof Error && error.message === 'EXISTS')
            // TODO: make sure reset does not happen, if models are the same.
            return await this._syncRead(id);
          throw error;
        }
      } else return await this._syncRead(id);
    } else {
      const time = +cursor[0];
      const seq = +cursor[1];
      return await this._syncRebaseAndMerge(req);
    }
  }

  private async _syncCreate(req: LocalRepoSyncRequest): Promise<LocalRepoSyncResponse> {
    const {remote, model} = await this.create(req);
    const time = model.clock.time - 1;
    const seq = -1;
    const cursor = [time, seq];
    return {cursor, remote};
  }

  private async _syncRebaseAndMerge(req: LocalRepoSyncRequest): Promise<LocalRepoSyncResponse> {
    const {id, patches} = req;
    const keyBase = await this.blockKeyBase(id);
    if (!patches || !patches.length) throw new Error('EMPTY_BATCH');
    const rebasedPatches: Uint8Array[] = [];
    const cursor = [0, -1];
    // TODO: Check if `patches` need rebasing, if not, just merge.
    // TODO: Return correct response.
    // TODO: Check that remote state is in sync, too.
    let nonSchemaPatchesInFrontier = false;
    let nonSchemaPatchesInWrite = false;
    await this.lockBlock(keyBase, async () => {
      let nextTick = 1;
      const [tip, meta] = await Promise.all([
        this.readFrontierTip(keyBase),
        this.readMeta(keyBase),
      ]);
      cursor[1] = meta.seq;
      if (tip) {
        const tipTime = tip.getId()?.time ?? 0;
        nextTick = tipTime + tip.span() + 1; // TODO: Shall we add 1 here?
        if (tip.getId()?.sid !== SESSION.GLOBAL) nonSchemaPatchesInFrontier = true;
      }
      const ops: BinStrLevelOperation[] = [];
      const sid = this.sid;
      const length = patches.length;
      for (let i = 0; i < length; i++) {
        const patch = patches[i];
        const patchId = patch.getId();
        if (!patchId) throw new Error('PATCH_ID_MISSING');
        const isSchemaPatch = patchId.sid === SESSION.GLOBAL && patchId.time === 1;
        if (isSchemaPatch) {
          cursor[0] = patchId.time + patch.span() - 1;
          if (tip) {
            const patchAheadOfTip = patchId.time > tip.getId()!.time;
            if (!patchAheadOfTip) continue;
          }
        } else nonSchemaPatchesInWrite = true;
        let rebased = patch;
        if (patchId.sid === sid) {
          rebased = patch.rebase(nextTick);
          nextTick = rebased.getId()!.time + rebased.span();
        }
        const id = rebased.getId()!;
        const time = id.time;
        cursor[0] = time + rebased.span() - 1;
        const patchKey = this.frontierKey(keyBase, time);
        const uint8 = rebased.toBinary();
        rebasedPatches.push(uint8);
        const op: BinStrLevelOperation = {
          type: 'put',
          key: patchKey,
          value: uint8,
        };
        ops.push(op);
      }
      await this.kv.batch(ops);
    });
    const remote = this.markDirtyAndSync(id).then(() => {});
    remote.catch(() => {});
    if (rebasedPatches.length)
      this.pubsub.pub({type: 'rebase', id, patches: rebasedPatches});
    const needsReset = nonSchemaPatchesInFrontier || nonSchemaPatchesInWrite;
    if (needsReset) {
      const {cursor, model} = await this._syncRead0(keyBase);
      return {cursor, model, remote};
    }
    return {cursor, remote};
  }

  private async _syncRead0(keyBase: string): Promise<LocalRepoSyncResponse> {
    const [model, meta, frontier] = await Promise.all([this.readModel(keyBase), this.readMeta(keyBase), this.readFrontier0(keyBase)]);
    model.applyBatch(frontier);
    const cursor = [model.clock.time - 1, meta.seq];
    return {
      model,
      cursor,
      remote: Promise.resolve(),
    };
  }

  private async _syncRead(id: BlockId): Promise<LocalRepoSyncResponse> {
    const keyBase = await this.blockKeyBase(id);
    return this._syncRead0(keyBase);
  }

  public async del(id: BlockId): Promise<void> {
    const keyBase = await this.blockKeyBase(id);
    const frontierKeyBase = this.frontierKeyBase(keyBase);
    const batchKeyBase = this.batchKeyBase(keyBase);
    const snapshotKeyBase = this.snapshotKeyBase(keyBase);
    const kv = this.kv;
    await this.lockBlock(keyBase, async () => {
      await kv.batch([
        {type: 'del', key: keyBase + Defaults.Metadata},
        {type: 'del', key: keyBase + Defaults.Model},
      ]);
      this.pubsub.pub({id, type: 'del'});
      await Promise.all([
        kv.clear({
          gt: frontierKeyBase,
          lt: frontierKeyBase + '~',
        }),
        kv.clear({
          gt: batchKeyBase,
          lt: batchKeyBase + '~',
        }),
        kv.clear({
          gt: snapshotKeyBase,
          lt: snapshotKeyBase + '~',
        }),
      ]);
    });
  }

  /**
   * Pull from remote.
   */
  public async pull(id: BlockId): Promise<{model: Model, meta: BlockMeta}> {
    const keyBase = await this.blockKeyBase(id);
    try {
      const {seq} = await this.readMeta(keyBase);
      return await this.pullExisting(id, keyBase, seq);
    } catch (error) {
      if (!!error && typeof error === 'object' && (error as any).code === 'LEVEL_NOT_FOUND')
        return await this.pullNew(id, keyBase);
      throw error;
    }
  }

  protected async pullNew(id: BlockId, keyBase: string): Promise<{model: Model, meta: BlockMeta}> {
    const blockId = id.join('/');
    const {block} = await this.opts.rpc.read(blockId);
    const pubsub = this.pubsub;
    return this.lockBlock(keyBase, async () => {
      const exists = await this._exists(keyBase);
      if (exists) throw new Error('CONFLICT');
      const model = Model.load(block.snapshot.blob, this.sid);
      let seq = block.snapshot.seq;
      for (const batch of block.tip) {
        if (batch.seq <= seq) continue;
        seq = batch.seq;
        for (const patch of batch.patches)
          model.applyPatch(Patch.fromBinary(patch.blob));
      }
      const meta: BlockMeta = {
        time: 0,
        seq,
      };
      const blob = model.toBinary();
      await this._wrModel(keyBase, blob, meta);
      pubsub.pub({type: 'reset', id, model: blob});
      return {model, meta};
    });
  }

  protected async pullExisting(id: BlockId, keyBase: string, seq: number): Promise<{model: Model, meta: BlockMeta}> {
    // TODO: try catching up using batches, if not possible, reset
    // TODO: load batches to catch up with remote
    const blockId = id.join('/');
    const pull = await this.opts.rpc.pull(blockId, seq);
    const nextSeq = pull.batches.length ? pull.batches[pull.batches.length - 1].seq : pull.snapshot?.seq ?? seq;
    const pubsub = this.pubsub;
    return this.lockBlock(keyBase, async () => {
      const [model, meta] = await Promise.all([
        this.readModel(keyBase),
        this.readMeta(keyBase),
      ]);
      const seq2 = meta.seq;
      if (seq2 !== seq) throw new Error('CONFLICT');
      if (pull.snapshot) {
        if (nextSeq > seq2) {
          const model = Model.load(pull.snapshot.blob, this.sid);
          for (const batch of pull.batches)
            for (const patch of batch.patches)
              model.applyPatch(Patch.fromBinary(patch.blob));
          const modelBlob = model.toBinary();
          meta.seq = nextSeq;
          await this._wrModel(keyBase, modelBlob, meta);
          pubsub.pub({type: 'reset', id, model: modelBlob});
        }
        return {model, meta};
      }
      if (!model) throw new Error('NO_MODEL');
      const patches: Uint8Array[] = [];
      for (const batch of pull.batches)
        for (const patch of batch.patches) {
          model.applyPatch(Patch.fromBinary(patch.blob));
          patches.push(patch.blob);
        }
      meta.seq = nextSeq;
      await this._wrModel(keyBase, model.toBinary(), meta);
      pubsub.pub({type: 'merge', id, patches});
      return {model, meta};
    });
  }

  public change$(id: BlockId): Observable<LocalRepoEvent> {
    return defer(() => {
      const remoteSubscription = this._subRemote(id).subscribe(() => {});
      return this.pubsub.bus$.pipe(
        map((msg) => {
          switch (msg.type) {
            case 'rebase': {
              if (!deepEqual(id, msg.id)) return;
              const rebase: Patch[] = [];
              for (const blob of msg.patches) rebase.push(Patch.fromBinary(blob));
              const event: LocalRepoRebaseEvent = {rebase};
              return event;
            }
            // case 'pull': {
            //   if (!deepEqual(id, data.id)) return;
            //   const {batch, batches, snapshot} = data as LevelLocalRepoRemotePull;
            //   const merge: Patch[] = [];
            //   if (batches) for (const b of batches) for (const p of b.patches) merge.push(Patch.fromBinary(p.blob));
            //   if (snapshot) {
            //     const reset = Model.load(snapshot.blob, this.sid);
            //     if (batch) for (const p of batch.patches) reset.applyPatch(Patch.fromBinary(p.blob));
            //     reset.applyBatch(merge);
            //     const event: LocalRepoResetEvent = {reset};
            //     return event;
            //   } else {
            //     const event: LocalRepoChangeEvent = {merge};
            //     return event;
            //   }
            // }
            case 'reset': {
              if (!deepEqual(id, msg.id)) return;
              const reset = Model.load(msg.model, this.sid);
              const event: LocalRepoResetEvent = {reset};
              return event;
            }
            case 'merge': {
              if (!deepEqual(id, msg.id)) return;
              const event: LocalRepoMergeEvent = {
                merge: msg.patches.map((blob) => Patch.fromBinary(blob))
              };
              return event;
            }
            case 'del': {
              if (!deepEqual(id, msg.id)) return;
              const event: LocalRepoDeleteEvent = {del: true};
              return event;
            }
          }
        }),
        filter((event): event is LocalRepoEvent => !!event),
        finalize(() => {
          remoteSubscription.unsubscribe();
        }),
        share(),
      );
    });
  }

  private _subs: Record<string, Observable<void>> = {};

  protected _subRemote(id: BlockId): Observable<void> {
    const blockId = id.join('/');
    let sub = this._subs[blockId];
    if (sub) return sub;
    const source = defer(() => this.opts.rpc.listen(blockId).pipe(
      switchMap(async ({event}) => {
        switch (event[0]) {
          case 'new': await this.pull(id); break;
          case 'upd': await this._mergeBatch(id, event[1].batch); break;
          case 'del': await this.del(id); break;
        }
      }),
    ));
    sub = source.pipe(
      catchError((error) => source),
      finalize<void>(() => {
        delete this._subs[blockId];
      }),
      share(),
    );
    this._subs[blockId] = sub;
    return sub;
  }

  protected async _mergeBatch(id: BlockId, batch: ServerBatch): Promise<void> {
    const keyBase = await this.blockKeyBase(id);
    try {
      const meta = await this.readMeta(keyBase);
      if (meta.seq + 1 !== batch.seq) {
        await this.pull(id);
        return;
      }
    } catch (error) {
      if (!!error && typeof error === 'object' && (error as any).code === 'LEVEL_NOT_FOUND') {
        await this.pullNew(id, keyBase);
        return;
      }
      throw error;
    }
    await this.lockBlock(keyBase, async () => {
      const [model, meta] = await Promise.all([
        this.readModel(keyBase),
        this.readMeta(keyBase),
      ]);
      if (meta.seq + 1 !== batch.seq) throw new Error('CONFLICT');  
      const patches: Uint8Array[] = [];
      for (const patch of batch.patches) {
        model.applyPatch(Patch.fromBinary(patch.blob));
        patches.push(patch.blob);
      }
      meta.seq = batch.seq;
      await this._wrModel(keyBase, model.toBinary(), meta);
      this.pubsub.pub({type: 'merge', id, patches});
    });
  }
}
