import type {AbstractBatchOperation, AbstractLevel} from 'abstract-level';
import type {BlockId} from '../types';
import type {ServerBatch, ServerSnapshot} from '../../remote/types';
import type {PubSub} from '../../pubsub';

export type BinStrLevel = AbstractLevel<any, string, Uint8Array>;
export type BinStrLevelOperation = AbstractBatchOperation<BinStrLevel, string, Uint8Array>;

export interface BlockMeta {
  /**
   * The latest logical time that was successfully synced with the remote.
   */
  time: number;

  /**
   * The sequence number of the last remote batch that was successfully pulled.
   */
  seq: number;

  /**
   * Whether to track the history of the block. By default the block will
   * store only the latest state model. If history tracking is enabled to block
   * will store historic batches and the starting snapshot model, from
   * which to apply the batches.
   */
  hist?: boolean;
}

export type LevelLocalRepoCursor = [
  /**
   * The logical time of the local operations that the client has seen.
   */
  time: number,

  /**
   * The remote batch sequence number which the the client has seen.
   */
  seq: number,
];

export interface CrudLocalRepoCipher {
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
}

export type SyncResult = [block: BlockId, success: boolean, err?: Error | unknown];

export type LocalBatch = ServerBatch;
export type LocalSnapshot = ServerSnapshot;

export type LevelLocalRepoPubSub = PubSub<LevelLocalRepoPubSubMessage>;

export type LevelLocalRepoPubSubMessage =
  | LevelLocalRepoPubSubMessageRemoteReset
  | LevelLocalRepoPubSubMessageRemoteMerge
  | LevelLocalRepoPubSubMessageLocalRebase
  | LevelLocalRepoPubSubMessageDelete;

export interface LevelLocalRepoPubSubMessageRemoteReset {
  type: 'reset';
  id: BlockId;
  model: Uint8Array;
}

export interface LevelLocalRepoPubSubMessageRemoteMerge {
  type: 'merge';
  id: BlockId;
  patches: Uint8Array[];
}

export interface LevelLocalRepoPubSubMessageLocalRebase {
  type: 'rebase';
  id: BlockId;
  patches: Uint8Array[];
}

export interface LevelLocalRepoPubSubMessageDelete {
  type: 'del';
  id: BlockId;
}
