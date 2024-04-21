import type {JsonCrdtTestSetup} from "../../__demos__/json-crdt-server/__tests__/setup";
import type {ApiTestSetup} from "../../common/rpc/__tests__/runApiTests";

export const runUtilTests = (_setup: ApiTestSetup, params: {staticOnly?: true} = {}) => {
  const setup = _setup as JsonCrdtTestSetup;

  describe('util.*', () => {
    describe('util.ping', () => {
      test('returns pong', async () => {
        const {call} = await setup();
        const res = await call('util.ping', {});
        expect(res).toBe('pong');
      });
    });

    describe('util.echo', () => {
      test('returns strings', async () => {
        const {call} = await setup();
        const res = await call('util.echo', 'hello world');
        expect(res).toBe('hello world');
      });

      test('returns objects', async () => {
        const {call} = await setup();
        const res = await call('util.echo', {foo: 'bar'});
        expect(res).toStrictEqual({foo: 'bar'});
      });
    });

    describe('util.info', () => {
      test('returns stats object', async () => {
        const {call} = await setup();
        const res = await call('util.info', {});
        expect(res).toMatchObject({
          now: expect.any(Number),
          stats: {
            pubsub: {
              channels: expect.any(Number),
              observers: expect.any(Number),
            },
            presence: {
              rooms: expect.any(Number),
              entries: expect.any(Number),
              observers: expect.any(Number),
            },
            blocks: {
              blocks: expect.any(Number),
              patches: expect.any(Number),
            },
          },
        });
      });
    });
  });
};
