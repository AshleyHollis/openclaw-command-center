import { createHash } from 'node:crypto';

const categories = new Set(['Reminder', 'High', 'Critical']);
const safeSeverity = (value) => categories.has(value) ? value : 'Attention';

export function notificationPreview({ severity, kind = 'attention', genericPreview = false, summaryCount = 0 } = {}) {
  if (genericPreview) return Object.freeze({ title: 'Command Center', body: 'Open Command Center to review an item.' });
  if (kind === 'quiet-summary') {
    const count = Number.isSafeInteger(summaryCount) && summaryCount > 0 ? summaryCount : 1;
    return Object.freeze({ title: 'Command Center · Attention', body: `${count} item${count === 1 ? '' : 's'} need review.` });
  }
  const label = safeSeverity(severity);
  if (kind === 'reminder' || label === 'Reminder') return Object.freeze({ title: 'Command Center · Reminder', body: 'A Reminder is due.' });
  if (label === 'Critical') return Object.freeze({ title: 'Command Center · Critical', body: 'A Critical item needs review.' });
  if (label === 'High') return Object.freeze({ title: 'Command Center · High', body: 'A High item needs review.' });
  return Object.freeze({ title: 'Command Center · Attention', body: 'An item needs review.' });
}

export function opaqueNotificationId(value, prefix = 'cc') {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('base64url').replace(/[^A-Za-z0-9.:-]/gu, '').slice(0, 48);
  return `${prefix}-${digest}`;
}

export function sensitivePreviewSafe(preview) {
  return Boolean(preview && typeof preview.title === 'string' && typeof preview.body === 'string'
    && preview.title.length <= 80 && preview.body.length <= 256
    && !/[\\/]|(?:token|secret|credential|password|cookie|session|path|log|note|conversation|parameter|identifier)/iu.test(`${preview.title} ${preview.body}`));
}
