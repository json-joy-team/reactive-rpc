import {Subject, type Subscription, type Subscriber} from 'rxjs';
import {RpcError, RpcErrorCodes} from '../../common/rpc/caller';

export class BufferSubject<T> extends Subject<T> {
  private buffer: T[] = [];
  private isBuffering = true;

  constructor(public readonly bufferSize: number) {
    super();
  }

  protected _subscribe(subscriber: Subscriber<T>): Subscription {
    // @ts-ignore
    this._throwIfClosed();
    // @ts-ignore
    const subscription = this._innerSubscribe(subscriber);
    const {buffer} = this;
    for (let i = 0; i < buffer.length && !subscriber.closed; i += 1) {
      subscriber.next(buffer[i] as T);
    }
    // @ts-ignore
    this._checkFinalizedStatuses(subscriber);
    return subscription;
  }

  public next(value: T): void {
    if (this.isBuffering) {
      if (this.buffer.length >= this.bufferSize) {
        this.error(RpcError.fromCode(RpcErrorCodes.BUFFER_OVERFLOW));
        return;
      }
      this.buffer.push(value);
    }
    super.next(value);
  }

  public flush(): void {
    this.isBuffering = false;
    this.buffer = [];
  }
}
