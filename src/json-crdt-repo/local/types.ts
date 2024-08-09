import type {ITimestampStruct, Model, Patch} from 'json-joy/lib/json-crdt';
import type {FanOut} from 'thingies/lib/fanout';

export type BlockId = [...collection: string[], id: string] | string[];

/**
 * The local repo persists data on the local device. It is the primary building
 * block for the local-first applications. The local repo also facilitates
 * synchronization and conflict resolution between multiple tabs or processes
 * running on the same device.
 */
export interface LocalRepo {
  /**
   * Synchronizes an in-memory editing session changes to the locally stored
   * data. The `sync` call is used to create, read, and update data.
   */
  sync(request: LocalRepoSyncRequest): Promise<LocalRepoSyncResponse>;

  /**
   * Deletes a block (document) from the local repo.
   */
  del(id: BlockId): Promise<void>;

  /**
   * Subscribes to changes in the local repo. The changes can be coming from
   * remote peers as well as other tabs or processes from the same device.
   */
  sub(id: BlockId): FanOut<LocalRepoSubData>;
}

/**
 * A single "sync" call servers as three different operations: "create", "read",
 * and "update".
 *
 * - When `cursor` is not set and `batch` is set, the call is equivalent to "create".
 * - When `cursor` and `batch` ar both not set, the call is equivalent to "read".
 * - When `cursor` is set and `batch` is set, the call is equivalent to "update".
 */
export interface LocalRepoSyncRequest {
  /**
   * Unique ID of the block.
   */
  id: BlockId;

  /**
   * When a new block is created, the client can specify whether the block
   * should be created only if it does not exist yet, or if it should be
   * created only if it already exists.
   */
  throwIf?: 'missing' | 'exists';

  /**
   * Latest known cursor position of already loaded data. If `null`, means that
   * no data was loaded yet. Setting this to `null` will load the latest
   * `Model` snapshot, making this call equivalent to "read" operation.
   */
  cursor?: ITimestampStruct;

  /**
   * List of changes that the client wants to persist.
   */
  batch?: Patch[];
}

export interface LocalRepoSyncResponse {
  /**
   * List of changes that the client should apply to the local state.
   */
  rebase?: Patch[];

  /**
   * Model snapshot that the client should reset its "start" state to. The
   * `Model` is sent when `rebase` patches are not available, or when the
   * patch set is too large.
   */
  model?: Model;

  /**
   * Promise that resolves when the local changes have been successfully
   * synchronized with the server or remote peers.
   */
  remote?: Promise<void>;

  /**
   * Fan-out subscription to the latest changes in the block. The subscription
   * emits `patches` when new changes are received from other clients. If the
   * `model` is set, the client should reset its state to the new `Model`
   * (happens when too many patches are received).
   */
  pull: FanOut<{patches: Patch[]} | {model: Model}>;
}

export interface LocalRepoSubData {
  /**
   * List of changes received from other clients.
   */
  batch?: Patch[];
}
