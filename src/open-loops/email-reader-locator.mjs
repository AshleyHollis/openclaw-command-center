import { createHash } from 'node:crypto';
import { sourceError } from '../sources/errors.mjs';

function stableUuid(value) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

export function intakeSourceOperationId(sourceExternalId, sourceVersion) {
  return stableUuid(`command-center:intake-source:email:${sourceExternalId}:${sourceVersion}`);
}

export function emailReaderLocatorOperationId(sourceExternalId, sourceVersion) {
  return stableUuid(`command-center:email-reader-locator:${sourceExternalId}:${sourceVersion}`);
}

export function validatedOutlookWebLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value) throw sourceError('invalid-request', 'Outlook reader destination is invalid.');
  let url;
  try { url = new URL(value); } catch { throw sourceError('invalid-request', 'Outlook reader destination is invalid.'); }
  const hosts = new Set(['outlook.office.com', 'outlook.office365.com', 'outlook.live.com']);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname.toLowerCase()) || url.username || url.password || url.port || url.hash || !/^\/(?:owa(?:\/|$)|mail(?:\/|$))/iu.test(url.pathname)) throw sourceError('invalid-request', 'Outlook reader destination is invalid.');
  for (const key of url.searchParams.keys()) if (/(?:token|secret|password|credential|auth|code|sig|key)/iu.test(key)) throw sourceError('invalid-request', 'Outlook reader destination includes credential-like parameters.');
  return url.href;
}
