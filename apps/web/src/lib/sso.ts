/**
 * Full-page navigation into a sign-in flow; the API redirects to the IdP and back. Linking an
 * account starts with a POST instead (`/auth/sso/:id/link`).
 */
export function ssoStartUrl(
  providerId: string,
  opts: { mode?: 'login' | 'test'; redirect?: string } = {},
) {
  const q = new URLSearchParams();
  if (opts.mode && opts.mode !== 'login') q.set('mode', opts.mode);
  if (opts.redirect) q.set('redirect', opts.redirect);
  const qs = q.toString();
  return `/api/auth/sso/${encodeURIComponent(providerId)}/start${qs ? `?${qs}` : ''}`;
}

const LAST_SSO_COOKIE = 'ordo_last_sso';

/** The provider this device last signed in with (set by the server on a successful SSO sign-in). */
export function lastSso(): { providerId: string; name: string; workspace: string } | null {
  const raw = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${LAST_SSO_COOKIE}=`))
    ?.slice(LAST_SSO_COOKIE.length + 1);
  if (!raw) return null;
  try {
    const json = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const value = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))),
    );
    return typeof value?.providerId === 'string' && typeof value?.name === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function forgetLastSso() {
  // biome-ignore lint/suspicious/noDocumentCookie: synchronous and supported everywhere, unlike cookieStore
  document.cookie = `${LAST_SSO_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
