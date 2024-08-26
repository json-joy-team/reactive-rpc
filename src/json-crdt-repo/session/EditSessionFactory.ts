import {Model, NodeBuilder} from 'json-joy/lib/json-crdt';
import {BlockId, LocalRepo} from '../local/types';
import {EditSession} from './EditSession';

export interface EditSessionFactoryOpts {
  readonly sid: number;
  readonly repo: LocalRepo;
}

export class EditSessionFactory {
  constructor(protected readonly opts: EditSessionFactoryOpts) {}

  public make({id, schema, pull = true}: EditSessionMakeOpts): EditSession {
    const opts = this.opts;
    const model = Model.create(schema, opts.sid);
    const session = new EditSession(opts.repo, id, model);
    if (pull) session.pullSilent();
    return session;
  }

  public async load(opts: EditSessionLoadOpts): Promise<EditSession> {
    const id = opts.id;
    const repo = this.opts.repo;
    const {model} = await repo.get(id);
    const session = new EditSession(repo, id, model);
    return session;
  }
}

/**
 * Constructs a new editing session synchronously.
 */
export interface EditSessionMakeOpts {
  /** Block ID. */
  id: BlockId;

  /** Thew new block schema, if any. */
  schema?: NodeBuilder;

  /**
   * Weather to asynchronously pull for any existing local block state, if a
   * block with the same ID already exists. Defaults to `true`.
   */
  pull?: boolean;
}

/**
 * Constructs and editing session asynchronously from an existing block. In
 * case the block does not exist, it is possible to create one or throw an
 * error.
 */
export interface EditSessionLoadOpts {
  /** Block ID. */
  id: BlockId;

  /** Thew new block schema, if any. */
  schema?: NodeBuilder;

  local?: {
    throwIf?: '' | 'missing' | 'exists';
  };

  remote?: {
    throwIf?: '' | 'missing' | 'exists';
    timeout?: number;
    throwOnTimeout?: boolean;
  };
}
