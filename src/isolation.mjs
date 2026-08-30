import net from 'node:net';

const trafficEvidenceLimit = 10;

function boundedText(value, maximum = 160) {
  return String(value ?? '<unknown>')
    .replace(/[\r\n]/g, ' ')
    .replace(/(bearer|basic)\s+[^\s]+/gi, '$1 [redacted]')
    .replace(/([?#&](?:token|password|secret|key)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(token|cookie|password|secret|key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, maximum);
}

/** Return only the bounded, non-payload traffic facts useful in a failure. */
export function boundedTrafficEvidence(attempts, limit = trafficEvidenceLimit) {
  return Object.freeze(attempts.slice(0, limit).map(({ source, destination }) => Object.freeze({
    source: boundedText(source),
    destination: boundedText(destination)
  })));
}

export function describeTrafficEvidence(attempts, limit = trafficEvidenceLimit) {
  const evidence = boundedTrafficEvidence(attempts, limit);
  const rendered = evidence.map(({ source, destination }) => `${source} -> ${destination}`);
  if (attempts.length > evidence.length) rendered.push('[truncated]');
  return rendered.join(', ');
}

export function isLoopbackDestination(destination) {
  if (typeof destination !== 'string' || destination === '0.0.0.0') return false;
  const normalized = destination.startsWith('[') && destination.endsWith(']') ? destination.slice(1, -1) : destination;
  const family = net.isIP(normalized);
  return (family === 4 && normalized.split('.').every((part, index) => index === 0 ? part === '127' : /^\d{1,3}$/.test(part) && Number(part) <= 255)) || (family === 6 && normalized === '::1');
}

export class TrafficGuard {
  constructor() { this.attempts = []; }
  assert(destination, source) {
    const permitted = isLoopbackDestination(destination);
    const attempt = Object.freeze({ destination, source, permitted });
    this.attempts.push(attempt);
    if (!permitted) {
      const error = new Error(`Prohibited ${boundedText(source)} destination: ${boundedText(destination)}`);
      error.diagnostics = Object.freeze({ traffic: boundedTrafficEvidence([attempt]) });
      throw error;
    }
    return attempt;
  }
  assertClean() {
    const prohibited = this.attempts.filter((attempt) => !attempt.permitted);
    if (prohibited.length) {
      const error = new Error(`Isolation recorded ${prohibited.length} prohibited destination(s): ${describeTrafficEvidence(prohibited)}`);
      error.diagnostics = Object.freeze({ traffic: boundedTrafficEvidence(prohibited) });
      throw error;
    }
  }
}

export function assertWebSocketDestination(guard, url) {
  let destination = '';
  try { destination = new URL(url).hostname; } catch { /* malformed URLs are prohibited */ }
  return guard.assert(destination, 'browser-websocket');
}
