const invalid = message => Object.assign(new Error(message), { code: 'invalid-request' });

export function validatedOutlookWebLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value) throw invalid('Outlook reader destination is invalid.');
  let url;
  try { url = new URL(value); } catch { throw invalid('Outlook reader destination is invalid.'); }
  const hosts = new Set(['outlook.office.com', 'outlook.office365.com', 'outlook.live.com']);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname.toLowerCase()) || url.username || url.password || url.port || url.hash || !/^\/(?:owa(?:\/|$)|mail(?:\/|$))/iu.test(url.pathname)) throw invalid('Outlook reader destination is invalid.');
  for (const key of url.searchParams.keys()) if (/(?:token|secret|password|credential|auth|code|sig|key)/iu.test(key)) throw invalid('Outlook reader destination includes credential-like parameters.');
  return url.href;
}
