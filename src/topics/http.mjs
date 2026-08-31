import { invokeBridgeMethod } from '../bridge/register.mjs';
import { isCanonicalUuid } from '../sources/operation-journal.mjs';
import { publicTopicDestination } from './snapshot.mjs';

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw new Error('Request body exceeds 32 KiB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 32_768) {
    res.statusCode = 507;
    res.end(JSON.stringify({ schemaVersion: 1, status: 'error', code: 'response-too-large' }));
    return;
  }
  res.statusCode = statusCode;
  res.end(body);
}

const topicActions = Object.freeze({
  create: 'command-center.v1.topics.create',
  'provisioning.retry': 'command-center.v1.topics.provisioning.retry',
  'provisioning.rollback': 'command-center.v1.topics.provisioning.rollback',
  rename: 'command-center.v1.topics.rename',
  'recategorize.preview': 'command-center.v1.topics.structural-change.preview',
  'recategorize.apply': 'command-center.v1.topics.structural-change.confirm',
  'archive.preview': 'command-center.v1.topics.archive.preview',
  'archive.apply': 'command-center.v1.topics.archive.confirm',
  restore: 'command-center.v1.topics.restore.confirm',
  'recovery.verify': 'command-center.v1.topics.recovery.verify',
  'recovery.relink': 'command-center.v1.topics.recovery.relink',
  'recovery.replace-session': 'command-center.v1.topics.recovery.replace'
});

const publicParaCategories = new Set(['project', 'area', 'resource', 'archive']);

function publicPreviewChange({ aspect, from, to, managed } = {}) {
  if (aspect === 'note-folder-location') return { aspect, ...(managed === undefined ? {} : { managed }), fromConvention: 'current-managed', toConvention: 'target-conventional' };
  if (aspect === 'category' && publicParaCategories.has(from) && publicParaCategories.has(to)) return { aspect, from, to, ...(managed === undefined ? {} : { managed }) };
  return { aspect, ...(managed === undefined ? {} : { managed }) };
}

function limitDestination(result, limit) {
  let remaining = limit;
  const take = (values) => {
    const selected = (Array.isArray(values) ? values : []).slice(0, remaining);
    remaining -= selected.length;
    return selected;
  };
  const groups = result?.activeGroups ?? result?.groups ?? {};
  return {
    activeGroups: {
      project: take(groups.project),
      area: take(groups.area),
      resource: take(groups.resource)
    },
    provisioning: take(result?.provisioning),
    recovery: take(result?.recovery),
    archived: take(result?.archived),
    retired: take(result?.retired)
  };
}

export function createTopicsReadHttpHandler(service) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers?.origin;
    if (origin === 'null') {
      res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    } else if (origin !== undefined) { sendJson(res, 403, { schemaVersion: 1, status: 'error', code: 'origin-not-allowed' }); return true; }
    if (req.method !== 'GET') { sendJson(res, 405, { schemaVersion: 1, status: 'error', code: 'method-not-allowed' }); return true; }
    try {
      const url = new URL(req.url ?? '/', 'http://command-center.invalid');
      const base = '/plugins/command-center/api/topics';
      const suffix = url.pathname.slice(base.length);
      if ([...url.searchParams.keys()].some((key) => !['limit', 'cursor', 'view'].includes(key))) throw new Error('Unsupported Topics query field.');
      if (url.searchParams.get('cursor') || !['', 'destination'].includes(url.searchParams.get('view') ?? '')) throw new Error('Unsupported Topics view or cursor.');
      const limit = Number(url.searchParams.get('limit') ?? 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Topics limit must be 1..100.');
      const result = suffix === '' || suffix === '/'
        ? limitDestination(await invokeBridgeMethod(service, 'command-center.v1.topics.list', { schemaVersion: 1 }), limit)
        : /^\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(suffix)
          ? { topic: await service.topics.getDestinationVerified(suffix.slice(1)) }
          : (() => { throw new Error('Canonical Topic ID is required.'); })();
      sendJson(res, 200, { schemaVersion: 1, status: 'applied', result });
    } catch { sendJson(res, 400, { schemaVersion: 1, status: 'error', code: 'invalid-request', message: 'Topics read failed.' }); }
    return true;
  };
}

function sanitizeFrameResult(method, result) {
  if (method === 'command-center.v1.topics.list') return result;
  if (result?.preview) {
    const { kind, topicId, structuralChangeId, from, to, digest, expectedRevisions, commitments, policy } = result.preview;
    const changes = (result.preview.changes ?? []).slice(0, 4).map(publicPreviewChange);
    return { preview: { schemaVersion: 1, kind, topicId, structuralChangeId, ...(publicParaCategories.has(from) ? { from } : {}), ...(publicParaCategories.has(to) ? { to } : {}), changes, digest, expectedRevisions, commitments: commitments ?? [], ...(policy ? { policy } : {}) } };
  }
  const value = result?.value ?? result;
  return { value: { status: value?.status ?? 'applied', topicId: value?.topic?.topicId ?? value?.topicId ?? null } };
}

async function mutationDestination(service) {
  // Exact-source verification is side-effect-free and prevents an out-of-band
  // missing source from being returned as an actionable active Topic.
  const list = service.topics.listDestinationPageVerified
    ? await service.topics.listDestinationPageVerified({ cursor: 0, limit: 100 })
    : service.topics.listDestinationVerified
      ? await service.topics.listDestinationVerified()
    : service.topics.listDestination
      ? service.topics.listDestination()
      : {};
  return publicTopicDestination(list);
}

function allowOpaqueFrame(req, res) {
  const origin = req.headers?.origin;
  if (origin === 'null') {
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    return true;
  }
  return origin === undefined;
}

export function createTopicsShellDataHttpHandler(service) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!allowOpaqueFrame(req, res)) { sendJson(res, 403, { schemaVersion: 1, status: 'error', code: 'origin-not-allowed' }); return true; }
    if (req.method !== 'GET') { sendJson(res, 405, { schemaVersion: 1, status: 'error', code: 'method-not-allowed' }); return true; }
    try {
      const url = new URL(req.url ?? '/', 'http://command-center.invalid');
      const view = url.searchParams.get('view');
      if (view === 'destination') {
        if ([...url.searchParams.keys()].some((key) => !['view', 'cursor', 'limit'].includes(key))) throw new Error('Closed destination query required.');
        const cursor = Number(url.searchParams.get('cursor') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const result = await service.topics.listDestinationPageVerified({ cursor, limit });
        sendJson(res, 200, { schemaVersion: 1, status: 'applied', result: publicTopicDestination(result) });
        return true;
      }
      if (view === 'search') {
        if ([...url.searchParams.keys()].some((key) => !['view', 'topicId', 'query', 'limit'].includes(key))) throw new Error('Closed search query required.');
        const result = await invokeBridgeMethod(service, 'command-center.v1.search.query', {
          schemaVersion: 1,
          topicId: url.searchParams.get('topicId'),
          query: url.searchParams.get('query'),
          limit: Number(url.searchParams.get('limit') ?? 20)
        });
        sendJson(res, 200, { schemaVersion: 1, status: 'applied', result });
        return true;
      }
      throw new Error('A closed shell data view is required.');
    } catch (error) {
      sendJson(res, error?.code === 'source-unavailable' ? 422 : 400, { schemaVersion: 1, status: 'error', code: String(error?.code ?? 'invalid-request'), message: 'Topics shell data request failed.' });
      return true;
    }
  };
}

export function createTopicsSearchHttpHandler(service) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers?.origin;
    if (origin === 'null') {
      res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    } else if (origin !== undefined) {
      res.statusCode = 403;
      res.end(JSON.stringify({ schemaVersion: 1, status: 'error', code: 'origin-not-allowed' }));
      return true;
    }
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end(JSON.stringify({ schemaVersion: 1, status: 'error', code: 'method-not-allowed' }));
      return true;
    }
    try {
      const url = new URL(req.url ?? '/', 'http://command-center.invalid');
      if ([...url.searchParams.keys()].some((key) => !['topicId', 'query', 'limit'].includes(key))) throw new Error('A closed archived search request is required.');
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const params = { schemaVersion: 1, topicId: url.searchParams.get('topicId'), query: url.searchParams.get('query'), limit };
      const result = await invokeBridgeMethod(service, 'command-center.v1.search.query', params);
      sendJson(res, 200, { schemaVersion: 1, status: 'applied', result });
    } catch (error) {
      res.statusCode = error?.code === 'invalid-request' ? 400 : 422;
      res.end(JSON.stringify({ schemaVersion: 1, status: 'error', code: String(error?.code ?? 'invalid-request'), message: 'Archived search failed.' }));
    }
    return true;
  };
}

export function createTopicsHttpHandler(service, { gatewayRequestFactory, mutationAllowed = true } = {}) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    // The external tab deliberately runs without allow-same-origin, so its
    // origin is serialized as `null`. Keep this CORS exception limited to that
    // scripts-only frame and the route's single JSON POST surface.
    const origin = req.headers?.origin;
    if (origin === 'null') {
      res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('Vary', 'Origin');
    } else if (origin !== undefined) {
      res.statusCode = 403;
      res.end(JSON.stringify({ schemaVersion: 1, status: 'error', code: 'origin-not-allowed' }));
      return true;
    }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ schemaVersion: 1, status: 'error', code: 'method-not-allowed' })); return true; }
    if (!mutationAllowed) { sendJson(res, 422, { schemaVersion: 1, status: 'error', code: 'capability-unavailable', message: 'Topics request failed.' }); return true; }
    try {
      if (String(req.headers?.['content-type'] ?? '').toLowerCase() !== 'application/json') throw Object.assign(new Error('JSON content type is required.'), { code: 'invalid-request' });
      const body = await readJson(req);
      if (!body || typeof body.action !== 'string') throw Object.assign(new Error('A closed Topic action request is required.'), { code: 'invalid-request' });
      const method = topicActions[body.action];
      if (!method || Object.keys(body).some((key) => !['action', ...['schemaVersion', 'topicId', 'name', 'paraCategory', 'logicalOperationId', 'expectedRevision', 'expectedSourceRevision', 'structuralChangeId', 'previewDigest', 'expectedRevisions', 'referenceId', 'replacementLocator', 'sessionKey', 'sessionId']].includes(key))) throw Object.assign(new Error('The route accepts only closed Topic lifecycle actions.'), { code: 'invalid-request' });
      if (!isCanonicalUuid(body.logicalOperationId) || body.action !== 'create' && (!isCanonicalUuid(body.topicId) || !Number.isInteger(body.expectedRevision))) throw Object.assign(new Error('Canonical operation identity, exact Topic identity, and Topic revision are required.'), { code: 'invalid-request' });
      const { action: _action, ...params } = body;
      const result = body.action === 'restore' && !body.previewDigest
        ? await (async () => {
            const current = service.topics.get(params.topicId);
            if (!current || current.revision !== params.expectedRevision) throw Object.assign(new Error('Restore Topic revision is stale.'), { code: 'conflict' });
            const preview = service.topics.restorePreview(params);
            return { value: await service.topics.restoreConfirm({ ...params, structuralChangeId: preview.structuralChangeId, previewDigest: preview.digest, expectedRevisions: preview.expectedRevisions }) };
          })()
        : await invokeBridgeMethod(service, method, params, null, null, body.action === 'create' && typeof gatewayRequestFactory === 'function' ? { gatewayRequest: gatewayRequestFactory() } : {});
      const frameResult = sanitizeFrameResult(method, result);
      const destination = await mutationDestination(service);
      if (frameResult.value) frameResult.value.destination = destination;
      else frameResult.destination = destination;
      sendJson(res, 200, { schemaVersion: 1, status: result?.status ?? result?.value?.status ?? 'applied', logicalOperationId: body.logicalOperationId, result: frameResult });
    } catch (error) {
      const destination = await mutationDestination(service).catch(() => null);
      const code = String(error?.code ?? 'invalid-request');
      sendJson(res, code === 'invalid-request' ? 400 : code === 'conflict' ? 409 : 422, { schemaVersion: 1, status: 'error', code, message: 'Topics request failed.', ...(destination ? { result: { destination } } : {}) });
    }
    return true;
  };
}
