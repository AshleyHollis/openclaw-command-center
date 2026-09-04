import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import { createGatewayRequestWorker } from '../src/gateway-request-worker.mjs';

test('trusted Gateway worker preserves its startup context for requests queued by a narrower caller', async () => {
  const context = new AsyncLocalStorage();
  const observed = [];
  let worker;

  await context.run('trusted-plugin-startup', async () => {
    worker = createGatewayRequestWorker({
      gateway: {
        async request(method, params, options) {
          observed.push({ context: context.getStore(), method, params, options });
          return { ok: true };
        }
      }
    });
  });

  const result = await context.run('browser-operator-write', () => worker.request('cron.add', { enabled: true }, { scopes: ['operator.admin'] }));
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(observed, [{ context: 'trusted-plugin-startup', method: 'cron.add', params: { enabled: true }, options: { scopes: ['operator.admin'] } }]);
  await worker.close();
});

test('trusted Gateway worker processes requests in order and rejects requests after close', async () => {
  const calls = [];
  const worker = createGatewayRequestWorker({ gateway: { async request(method) { calls.push(method); return method; } } });
  assert.deepEqual(await Promise.all([worker.request('first'), worker.request('second')]), ['first', 'second']);
  assert.deepEqual(calls, ['first', 'second']);
  await worker.close();
  await assert.rejects(() => worker.request('late'), (error) => error?.code === 'gateway-worker-stopped');
});
