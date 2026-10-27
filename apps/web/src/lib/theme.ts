import { type ThemeMode, themedColor } from '@ordo/shared';
import { useSyncExternalStore } from 'react';
import { readPref, writePref } from './store.ts';

/**
 * Light or dark, per browser. "system" follows the operating system and changes with it.
 * index.html applies the same choice before the first paint, so the page never flashes the
 * wrong theme; keep its inline script in step with apply() below.
 */
export type ThemePref = 'system' | 'light' | 'dark';

export const THEME_PREFS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** The browser chrome colour (address bar, PWA title bar) for each theme: its `bg`. */
const CHROME: Record<ThemeMode, string> = { dark: '#09090b', light: '#fbf9fa' };

const media = () =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

const listeners = new Set<() => void>();
let pref: ThemePref = readPref<ThemePref>('theme', 'system');
let mode: ThemeMode = resolve(pref);

function resolve(p: ThemePref): ThemeMode {
  if (p !== 'system') return p;
  return media()?.matches ? 'light' : 'dark';
}

function apply() {
  mode = resolve(pref);
  document.documentElement.dataset.theme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', CHROME[mode]);
  for (const l of listeners) l();
}

media()?.addEventListener('change', () => {
  if (pref === 'system') apply();
});

// Another tab changed the choice.
addEventListener('storage', (e) => {
  if (e.key !== 'ordo:theme') return;
  pref = readPref<ThemePref>('theme', 'system');
  apply();
});

export function setThemePref(next: ThemePref) {
  pref = next;
  writePref('theme', next);
  apply();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The chosen preference and the theme it resolves to. */
export function useTheme(): { pref: ThemePref; mode: ThemeMode } {
  const p = useSyncExternalStore(subscribe, () => pref);
  const m = useSyncExternalStore(subscribe, () => mode);
  return { pref: p, mode: m };
}

/** A user-chosen colour (status, label, project) as it should be drawn in the current theme. */
export function useThemedColor(color: string) {
  return themedColor(color, useTheme().mode);
}
