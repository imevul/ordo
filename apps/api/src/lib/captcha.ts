import type { RequestFormCaptchaProvider } from '@ordo/shared';

export type CaptchaVerifier = (
  provider: RequestFormCaptchaProvider,
  secret: string,
  token: string,
  ip: string | null,
) => Promise<boolean>;

const VERIFY_URLS: Record<RequestFormCaptchaProvider, string> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
};

/** Whether the provider accepts the token. A provider that can't be reached counts as a no. */
export const verifyCaptcha: CaptchaVerifier = async (provider, secret, token, ip) => {
  try {
    const res = await fetch(VERIFY_URLS[provider], {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token, ...(ip && { remoteip: ip }) }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { success?: boolean };
    return body.success === true;
  } catch {
    return false;
  }
};
