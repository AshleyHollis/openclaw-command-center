import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readAttentionStartupReadiness } from './support/attention-startup-readiness.mjs';
import { waitForConsecutiveReadiness } from '../src/host-harness.mjs';

const world = { gateway: { url: 'http://127.0.0.1:12345' } };
const pending = new Promise(() => {});
const healthy = async () => new Response('{"ok":true,"status":"live"}', { status: 200 });

test('Attention retries an actual refused HTTP listener before invoking the catalog', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/healthz'); response.setHeader('content-type', 'application/json');
    response.end('{"ok":true,"status":"live"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  let catalogs = 0, retries = 0;
  try {
    await waitForConsecutiveReadiness(signal => readAttentionStartupReadiness({ world: { gateway: { url: `http://127.0.0.1:${port}` } }, signal }, {
      fetchImpl: fetch, readCatalog: async () => { catalogs += 1; return true; }
    }), pending, { required: 1, deadlineMs: 2_000, delayMs: 1, wait: async () => {
      retries += 1; assert.equal(catalogs, 0);
      await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    } });
    assert.equal(retries, 1); assert.equal(catalogs, 1);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});

test('Attention waits for listener transport then still requires the authenticated catalog', async () => {
  let clock = 0, probes = 0, catalogs = 0;
  const signals = [];
  const fetchImpl = async (_url, { signal }) => {
    signals.push(signal); probes += 1;
    if (probes < 3) throw new TypeError('fetch failed', { cause: Object.assign(new Error('listener pending'), { code: probes === 1 ? 'ECONNREFUSED' : 'ECONNRESET' }) });
    return healthy();
  };
  const readCatalog = async ({ signal }) => { assert.equal(signal.aborted, false); assert.equal(signals.at(-1).aborted, false); catalogs += 1; return catalogs === 2; };
  await waitForConsecutiveReadiness(signal => readAttentionStartupReadiness({ world, signal }, { fetchImpl, readCatalog }), pending,
    { required: 1, deadlineMs: 1_000, delayMs: 100, now: () => clock, wait: async ms => { clock += ms; } });
  assert.equal(probes, 4); assert.equal(catalogs, 2); assert.equal(clock, 300);
});

test('Attention listener retries retain the original elapsed deadline', async () => {
  let clock = 0, probes = 0;
  await assert.rejects(waitForConsecutiveReadiness(signal => readAttentionStartupReadiness({ world, signal }, {
    fetchImpl: async () => { probes += 1; throw Object.assign(new Error('not listening'), { code: 'ECONNREFUSED' }); },
    readCatalog: async () => assert.fail('Catalog must not run before listener admission')
  }), pending, { required: 1, deadlineMs: 250, delayMs: 100, now: () => clock, wait: async ms => { clock += ms; } }),
  error => error.category === 'readiness-timeout' && error.readiness.elapsedMs === 250);
  assert.equal(probes, 3);
});

for (const status of [401, 403, 404, 500, 503]) {
  test(`Attention HTTP ${status} refusal is terminal`, async () => {
    let probes = 0;
    await assert.rejects(waitForConsecutiveReadiness(signal => readAttentionStartupReadiness({ world, signal }, {
      fetchImpl: async () => { probes += 1; return new Response('{}', { status }); },
      readCatalog: async () => assert.fail('HTTP refusal must not reach catalog')
    }), pending, { deadlineMs: 1_000 }), new RegExp(`HTTP ${status}`));
    assert.equal(probes, 1);
  });
}

for (const body of ['not JSON', '{}', '{"ok":false,"status":"live"}', '{"ok":true,"status":"starting"}']) {
  test(`Attention malformed liveness is terminal: ${body}`, async () => {
    await assert.rejects(readAttentionStartupReadiness({ world }, {
      fetchImpl: async () => new Response(body, { status: 200 }),
      readCatalog: async () => assert.fail('Malformed liveness must not reach catalog')
    }), /invalid liveness/);
  });
}

for (const label of ['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_REQUEST', 'missing capability', 'unclassified socket failure']) {
  test(`Attention preserves authenticated catalog failure: ${label}`, async () => {
    const failure = new Error(label); let catalogs = 0;
    await assert.rejects(waitForConsecutiveReadiness(signal => readAttentionStartupReadiness({ world, signal }, {
      fetchImpl: healthy, readCatalog: async () => { catalogs += 1; throw failure; }
    }), pending, { deadlineMs: 1_000 }), error => error === failure);
    assert.equal(catalogs, 1);
  });
}

test('Attention cancellation stops a pending listener probe without a catalog request', async () => {
  const controller = new AbortController(); const failure = new Error('Fictional cancellation');
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const result = waitForConsecutiveReadiness(signal => readAttentionStartupReadiness({ world, signal }, {
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), readCatalog: async () => assert.fail('Cancelled listener must not reach catalog')
  }), pending, { deadlineMs: 1_000, signal: controller.signal });
  await started; controller.abort(failure);
  await assert.rejects(result, error => error === failure);
});

test('Attention original deadline aborts a pending listener probe', async () => {
  let probeSignal;
  await assert.rejects(waitForConsecutiveReadiness(signal => readAttentionStartupReadiness({ world, signal }, {
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      probeSignal = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), readCatalog: async () => assert.fail('Timed out listener must not reach catalog')
  }), pending, { deadlineMs: 20 }), error => error.category === 'readiness-timeout');
  assert.equal(probeSignal.aborted, true);
});
