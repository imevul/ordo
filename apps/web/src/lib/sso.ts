/** Full-page navigation into an OIDC flow; the API redirects to the IdP and back. */
export function ssoStartUrl(
  providerId: string,
  opts: { mode?: 'login' | 'link' | 'test'; redirect?: string } = {},
) {
  const q = new URLSearchParams();
  if (opts.mode && opts.mode !== 'login') q.set('mode', opts.mode);
  if (opts.redirect) q.set('redirect', opts.redirect);
  const qs = q.toString();
  return `/api/auth/oidc/${encodeURIComponent(providerId)}/start${qs ? `?${qs}` : ''}`;
}
