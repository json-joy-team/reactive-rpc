import {LevelLocalRepoCore, LevelLocalRepoCoreOpts} from './LevelLocalRepoCore';
import type {BlockId, LocalRepo, LocalRepoSyncRequest, LocalRepoSyncResponse} from '../types';

export interface LevelLocalRepoOpts extends LevelLocalRepoCoreOpts {}

export class LevelLocalRepo implements LocalRepo {
  protected readonly _core: LevelLocalRepoCore;

  constructor(opts: LevelLocalRepoOpts) {
    this._core = new LevelLocalRepoCore(opts);
  }

  public start(): void {
    this._core.start();
  }

  public async stop(): Promise<void> {
    await this._core.stop();
  }

  public async sync(request: LocalRepoSyncRequest): Promise<LocalRepoSyncResponse> {
    return await this._core.sync(request);
  }

  public async del(id: BlockId): Promise<void> {
    throw new Error('Method not implemented.');
  }
}
