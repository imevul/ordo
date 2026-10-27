import type { Passkey } from '@ordo/shared';
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import { api } from '../api/client.ts';

/**
 * Passkeys from the browser's side: the server hands out options and a challenge id, the
 * browser (and the person's device) answers, the server checks the answer.
 */

export const passkeysSupported = () => browserSupportsWebAuthn();

/** Passkeys can be used on this page: the browser has them, and this is the instance's address. */
export const passkeysHere = (origin: string | null | undefined) =>
  !!origin && origin === window.location.origin && passkeysSupported();
export const passkeyAutofillSupported = () => browserSupportsWebAuthnAutofill();

// biome-ignore lint/suspicious/noExplicitAny: WebAuthn options are passed through untouched.
type Options = { challengeId: string; options: any };

/** Adds a passkey on this device; `password` confirms it when the account has one. */
export async function addPasskey(password: string | undefined, name: string) {
  const { challengeId, options } = await api.post<Options>('/me/passkeys/options', { password });
  const response = await startRegistration({ optionsJSON: options });
  return api.post<Passkey>('/me/passkeys', { challengeId, response, name });
}

/**
 * Signs in with a passkey. With `autofill`, the browser offers passkeys in the email field's
 * suggestions instead of opening a dialog, and the promise waits until one is picked.
 */
export async function signInWithPasskey(autofill = false) {
  const { challengeId, options } = await api.post<Options>('/auth/passkey/options');
  const response = await startAuthentication({
    optionsJSON: options,
    useBrowserAutofill: autofill,
  });
  await api.post('/auth/passkey', { challengeId, response });
}

/** Stops a waiting autofill request (e.g. before starting a dialog one). */
export const cancelPasskeyRequest = () => WebAuthnAbortService.cancelCeremony();

/** The person backed out of the browser's prompt: nothing to report. */
export function passkeyCancelled(err: unknown) {
  const e = err as { name?: string; code?: string };
  return (
    e?.name === 'NotAllowedError' ||
    e?.name === 'AbortError' ||
    e?.code === 'ERROR_CEREMONY_ABORTED'
  );
}

/** A default name for a passkey made in this browser: "Firefox on macOS". */
export function deviceName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return [browser, os].filter(Boolean).join(' · ') || 'Passkey';
}
