import type { OfflineSyncMode } from '@ordo/shared';
import { useSyncExternalStore } from 'react';

/**
 * Whether this device keeps a copy of workspaces. The instance decides the default (or says no);
 * people on shared computers can turn it off for their browser, and with `optin` turn it on.
 */

const KEY = 'ordo:offlineCopy';
const EVENT = 'ordo:offlineCopy';

function stored(): 'on' | 'off' | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    return null;
  }
}

export function keepsCopy(mode: OfflineSyncMode | undefined) {
  if (!mode || mode === 'off' || typeof indexedDB === 'undefined') return false;
  const choice = stored();
  return mode === 'on' ? choice !== 'off' : choice === 'on';
}

export function setKeepsCopy(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // private window: nothing to remember it in
  }
  window.dispatchEvent(new Event(EVENT));
}

const subscribe = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  window.addEventListener('storage', fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener('storage', fn);
  };
};

export const useKeepsCopy = (mode: OfflineSyncMode | undefined) =>
  useSyncExternalStore(subscribe, () => keepsCopy(mode));
