function requestedHeaders(req) {
  return String(req.headers?.['access-control-request-headers'] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

export function allowOpaqueFrameRequest(req, res, { method, headers = [] }) {
  const origin = req.headers?.origin;
  if (origin !== undefined && origin !== 'null') return false;

  const allowedHeaders = headers.map((value) => value.toLowerCase()).sort();
  if (req.method === 'OPTIONS') {
    const requestedMethod = String(req.headers?.['access-control-request-method'] ?? '').toUpperCase();
    if (requestedMethod !== method || JSON.stringify(requestedHeaders(req)) !== JSON.stringify(allowedHeaders)) return false;
  }

  res.setHeader?.('Access-Control-Allow-Origin', 'null');
  res.setHeader?.('Access-Control-Allow-Methods', `${method}, OPTIONS`);
  if (headers.length > 0) res.setHeader?.('Access-Control-Allow-Headers', headers.join(', '));
  if (req.method === 'OPTIONS') res.setHeader?.('Access-Control-Allow-Private-Network', 'true');
  res.setHeader?.('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network');
  return true;
}
