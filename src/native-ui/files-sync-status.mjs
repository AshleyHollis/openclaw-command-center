const labels = new Map([
  ['paused', 'Paused'],
  ['waiting', 'Waiting for next sync'],
  ['running', 'Syncing'],
  ['succeeded', 'Last sync succeeded'],
  ['failed', 'Last sync failed'],
  ['unknown', 'Status unavailable']
]);

export function renderFilesSyncStatus(container, status) {
  container.setAttribute('role', 'status');
  const label = status?.schemaVersion === 1 ? labels.get(status.state) : undefined;
  container.hidden = !label;
  container.replaceChildren();
  if (!label) return;
  container.append(`OneDrive sync · ${label}`);
  if (typeof status.lastSuccessAt !== 'string') return;
  const lastSuccess = Date.parse(status.lastSuccessAt);
  if (!Number.isFinite(lastSuccess)) return;
  const time = container.ownerDocument.createElement('time');
  time.dateTime = new Date(lastSuccess).toISOString();
  time.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(lastSuccess);
  container.append(' · Last success ', time);
}
