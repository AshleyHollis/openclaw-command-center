function destination(value) {
  if (typeof value === 'string') {
    try { return new URL(value).hostname; } catch { return value; }
  }
  if (value instanceof URL) return value.hostname;
  if (typeof value?.url === 'string') return destination(value.url);
  return value?.hostname || value?.host || value?.address;
}

/** Resolve every standard Node connect overload to its explicit destination. */
export function destinationFromConnectionArguments(value, rest = []) {
  return destination(value) || destination(rest[0]);
}
