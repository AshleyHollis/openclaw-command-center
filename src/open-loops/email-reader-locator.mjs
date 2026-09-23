import { createHash } from 'node:crypto';

function stableUuid(value) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

export function intakeSourceOperationId(sourceExternalId, sourceVersion) {
  return stableUuid(`command-center:intake-source:email:${sourceExternalId}:${sourceVersion}`);
}

export function emailReaderLocatorOperationPrefix(sourceExternalId, sourceVersion) {
  return `email-reader.locator.v1:${createHash('sha256').update(JSON.stringify([sourceExternalId, sourceVersion])).digest('hex')}:`;
}

export function emailReaderLocatorOperationId(locator) {
  return `${emailReaderLocatorOperationPrefix(locator.sourceExternalId, locator.sourceVersion)}${createHash('sha256').update(JSON.stringify(locator)).digest('hex')}`;
}
