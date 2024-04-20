import {Codecs} from '@jsonjoy.com/json-pack/lib/codecs/Codecs';
import {Writer} from '@jsonjoy.com/util/lib/buffers/Writer';
import {copy} from '@jsonjoy.com/util/lib/buffers/copy';
import {enableCors} from './util';
import {Match, Router} from '@jsonjoy.com/jit-router';
import {IncomingBatchMessage, RpcMessageBatchProcessor} from '../../common/rpc/RpcMessageBatchProcessor';
import {RpcError, RpcErrorCodes, RpcErrorType} from '../../common/rpc/caller/error';
import {ConnectionContext} from '../context';
import {RpcMessageCodecs} from '../../common/codec/RpcMessageCodecs';
import {RpcValue} from '../../common/messages/Value';
import {RpcCodecs} from '../../common/codec/RpcCodecs';
import {type ReactiveRpcMessage, RpcMessageStreamProcessor, ReactiveRpcClientMessage} from '../../common';
import type {JsonValueCodec} from '@jsonjoy.com/json-pack/lib/codecs/types';
import type * as types from './types';
import type {RouteHandler} from './types';
import type {RpcCaller} from '../../common/rpc/caller/RpcCaller';

const HDR_BAD_REQUEST = Buffer.from('400 Bad Request', 'utf8');
const HDR_NOT_FOUND = Buffer.from('404 Not Found', 'utf8');
const ERR_NOT_FOUND = RpcError.fromCode(RpcErrorCodes.NOT_FOUND, 'Not Found');

const noop = (x: any) => {};

export interface RpcAppOptions {
  uws: types.TemplatedApp;
  caller: RpcCaller<any>;

  /**
   * Maximum request body size in bytes. Default is 1MB.
   */
  maxRequestBodySize?: number;

  /**
   * Serializers and de-serializers for request and response bodies.
   */
  codecs?: Codecs;

  /**
   * HTTP port to listen on. If not specified, the PORT environment variable
   * will be used, or 9999 if not set.
   */
  port?: number;

  /**
   * Host to listen to. If not specified, the HOST environment variable will be
   * used, or '0.0.0.0' if not set.
   */
  host?: string;

  /**
   * This method allows to augment connection context with additional data.
   *
   * @param ctx Connection context.
   */
  augmentContext?: (ctx: ConnectionContext) => void;

  /**
   * Logger to use for logging. If not specified, console will be used.
   */
  logger?: types.ServerLogger;
}

export class RpcApp<Ctx extends ConnectionContext> {
  public readonly codecs: RpcCodecs;
  protected readonly app: types.TemplatedApp;
  protected readonly maxRequestBodySize: number;
  protected readonly router = new Router();
  protected readonly batchProcessor: RpcMessageBatchProcessor<Ctx>;

  constructor(protected readonly options: RpcAppOptions) {
    this.app = options.uws;
    (this.maxRequestBodySize = options.maxRequestBodySize ?? 1024 * 1024),
      (this.codecs = new RpcCodecs(options.codecs ?? new Codecs(new Writer()), new RpcMessageCodecs()));
    this.batchProcessor = new RpcMessageBatchProcessor<Ctx>({caller: options.caller});
  }

  public enableCors() {
    enableCors(this.options.uws);
  }

  public routeRaw(method: types.HttpMethodPermissive, path: string, handler: RouteHandler<Ctx>): void {
    method = method.toLowerCase() as types.HttpMethodPermissive;
    this.router.add(method + path, handler);
  }

  public route(method: types.HttpMethodPermissive, path: string, handler: types.JsonRouteHandler<Ctx>): void {
    this.routeRaw(method, path, async (ctx: Ctx) => {
      const result = await handler(ctx);
      const res = ctx.res!;
      if (res.aborted) return;
      const codec = ctx.resCodec;
      const encoder = codec.encoder;
      const writer = encoder.writer;
      writer.reset();
      if (res instanceof RpcValue) {
        if (res.type) res.type.encoder(codec.format)(res.data, encoder);
        else encoder.writeAny(res.data);
      } else {
        encoder.writeAny(result);
      }
      if (res.aborted) return;
      ctx.sendResponse(writer.flush());
    });
  }

  public enableHttpPing(path: string = '/ping'): this {
    this.route('GET', path, async () => {
      return 'pong';
    });
    return this;
  }

  public enableHttpRpc(path: string = '/rpc'): this {
    this.routeRaw('POST', path, async (ctx: Ctx) => {
      try {
        const res = ctx.res!;
        const bodyUint8 = await ctx.requestBody(this.maxRequestBodySize);
        if (res.aborted) return;
        const messageCodec = ctx.msgCodec;
        const incomingMessages = messageCodec.decodeBatch(ctx.reqCodec, bodyUint8);
        try {
          const outgoingMessages = await this.batchProcessor.onBatch(incomingMessages as IncomingBatchMessage[], ctx);
          if (res.aborted) return;
          const resCodec = ctx.resCodec;
          messageCodec.encodeBatch(resCodec, outgoingMessages);
          const buf = resCodec.encoder.writer.flush();
          if (res.aborted) return;
          res.end(buf);
        } catch (error) {
          const logger = this.options.logger ?? console;
          logger.error('HTTP_RPC_PROCESSING', error, {messages: incomingMessages});
          throw RpcError.internal(error);
        }
      } catch (error) {
        if (typeof error === 'object' && error)
          if ((error as any).message === 'Invalid JSON') throw RpcError.badRequest();
        throw RpcError.from(error);
      }
    });
    return this;
  }

  public enableWsRpc(path: string = '/rpc'): this {
    const maxBackpressure = 4 * 1024 * 1024;
    const augmentContext = this.options.augmentContext ?? noop;
    const options = this.options;
    const logger = options.logger ?? console;
    const caller = options.caller;
    this.app.ws(path, {
      idleTimeout: 0,
      maxPayloadLength: 4 * 1024 * 1024,
      upgrade: (res, req, context) => {
        const secWebSocketKey = req.getHeader('sec-websocket-key');
        const secWebSocketProtocol = req.getHeader('sec-websocket-protocol');
        const secWebSocketExtensions = req.getHeader('sec-websocket-extensions');
        const ctx = ConnectionContext.fromWs(req, res, secWebSocketProtocol, null, this);
        augmentContext(ctx);
        /* This immediately calls open handler, you must not use res after this call */
        res.upgrade({ctx}, secWebSocketKey, secWebSocketProtocol, secWebSocketExtensions, context);
      },
      open: (ws_: types.WebSocket) => {
        try {
          const ws = ws_ as types.RpcWebSocket<Ctx>;
          const ctx = ws.ctx;
          const resCodec = ctx.resCodec;
          const msgCodec = ctx.msgCodec;
          const encoder = resCodec.encoder;
          ws.rpc = new RpcMessageStreamProcessor({
            caller,
            send: (messages: ReactiveRpcMessage[]) => {
              try {
                if (ws.getBufferedAmount() > maxBackpressure) return;
                const writer = encoder.writer;
                writer.reset();
                msgCodec.encodeBatch(resCodec, messages);
                const encoded = writer.flush();
                ws.send(encoded, true, false);
              } catch (error) {
                logger.error('WS_SEND', error, {messages});
              }
            },
            bufferSize: 1,
            bufferTime: 0,
          });
        } catch (error) {
          logger.error('RX_WS_OPEN', error);
        }
      },
      message: (ws_: types.WebSocket, buf: ArrayBuffer, isBinary: boolean) => {
        try {
          const ws = ws_ as types.RpcWebSocket<Ctx>;
          const ctx = ws.ctx;
          const reqCodec = ctx.reqCodec;
          const msgCodec = ctx.msgCodec;
          const uint8 = copy(new Uint8Array(buf));
          const rpc = ws.rpc!;
          try {
            const messages = msgCodec.decodeBatch(reqCodec, uint8) as ReactiveRpcClientMessage[];
            try {
              rpc.onMessages(messages, ctx);
            } catch (error) {
              logger.error('RX_RPC_PROCESSING', error, messages);
              return;
            }
          } catch (error) {
            logger.error('RX_RPC_DECODING', error, {codec: reqCodec.id, buf: Buffer.from(uint8).toString()});
          }
        } catch (error) {
          logger.error('RX_WS_MESSAGE', error);
        }
      },
      close: (ws_: types.WebSocket, code: number, message: ArrayBuffer) => {
        const ws = ws_ as types.RpcWebSocket<Ctx>;
        ws.rpc!.stop();
      },
    });
    return this;
  }

  public startRouting(): void {
    const matcher = this.router.compile();
    const codecs = this.codecs;
    let responseCodec: JsonValueCodec = codecs.value.json;
    const options = this.options;
    const augmentContext = options.augmentContext ?? noop;
    const logger = options.logger ?? console;
    this.app.any('/*', async (res: types.HttpResponse, req: types.HttpRequest) => {
      try {
        res.onAborted(() => {
          res.aborted = true;
        });
        const method = req.getMethod();
        const url = req.getUrl();
        try {
          const match = matcher(method + url) as undefined | Match;
          if (!match) {
            res.cork(() => {
              res.writeStatus(HDR_NOT_FOUND);
              res.end(RpcErrorType.encode(responseCodec, ERR_NOT_FOUND));
            });
            return;
          }
          const handler = match.data as RouteHandler<Ctx>;
          const params = match.params;
          const ctx = ConnectionContext.fromReqRes(req, res, params, this) as Ctx;
          responseCodec = ctx.resCodec;
          augmentContext(ctx);
          await handler(ctx);
        } catch (err) {
          if (err instanceof RpcValue) err = err.data;
          if (!(err instanceof RpcError)) err = RpcError.from(err);
          const error = <RpcError>err;
          if (error.errno === RpcErrorCodes.INTERNAL_ERROR) {
            logger.error('UWS_ROUTER_INTERNAL_ERROR', error, {originalError: error.originalError ?? null});
          }
          res.cork(() => {
            res.writeStatus(HDR_BAD_REQUEST);
            res.end(RpcErrorType.encode(responseCodec, error));
          });
        }
      } catch {}
    });
  }

  public startWithDefaults(): void {
    this.enableCors();
    this.enableHttpPing();
    this.enableHttpRpc();
    this.enableWsRpc();
    this.startRouting();
    const options = this.options;
    const port = options.port ?? +(process.env.PORT || 9999);
    const host = options.host ?? process.env.HOST ?? '0.0.0.0';
    const logger = options.logger ?? console;
    this.options.uws.listen(host, port, (token) => {
      if (token) {
        logger.log({msg: 'SERVER_STARTED', url: `http://localhost:${port}`});
      } else {
        logger.error('SERVER_START', new Error(`Failed to listen on ${port} port.`));
      }
    });
  }
}
