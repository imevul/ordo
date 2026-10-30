/**
 * Request URLs as they go into the logs, minus the secrets some of them carry: invite tokens,
 * inbound webhook keys, file signatures and sign-in codes. Anyone who can read the logs could
 * otherwise use them.
 */
const SECRET_PARAMS = new Set(['sig', 'code', 'state', 'token', 'access_token', 'key']);

export function redactUrl(url: string) {
  const [path = '', query] = url.split('?', 2);
  const safePath = path
    .replace(/^(\/api\/invites\/)[^/]+/, '$1…')
    // Each integration's own webhook URL ends in its key; app-wide ones (app-<id>) are public.
    .replace(/^(\/api\/hooks\/[^/]+\/)(?!app-)[^/]+/, '$1…');
  if (query === undefined) return safePath;
  const params = query
    .split('&')
    .map((pair) => {
      const name = decodeURIComponent(pair.split('=')[0]!);
      return SECRET_PARAMS.has(name) ? `${name}=…` : pair;
    })
    .join('&');
  return `${safePath}?${params}`;
}
