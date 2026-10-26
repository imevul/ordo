import type { CreateIssueInput } from '@ordo/shared';
import { useSyncExternalStore } from 'react';

/** Minimal global UI store (modals, palette) without a dependency. */
export type PalettePage =
  | 'root'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'labels'
  | 'project'
  | 'cycle'
  | 'estimate'
  | 'team';

interface UiState {
  createIssue: Partial<CreateIssueInput> | null;
  /** Open palette page, or null when closed. */
  palette: PalettePage | null;
  shortcuts: boolean;
  /** Issue ids the palette's contextual actions apply to (focused/selected issues). */
  paletteTargets: string[];
  /** Issues the current screen considers "focused or selected", for palette actions. */
  contextIssues: string[];
}

let state: UiState = {
  createIssue: null,
  palette: null,
  shortcuts: false,
  paletteTargets: [],
  contextIssues: [],
};
const listeners = new Set<() => void>();

export const ui = {
  get: () => state,
  set(patch: Partial<UiState>) {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  openCreateIssue(defaults: Partial<CreateIssueInput> = {}) {
    ui.set({ createIssue: defaults, palette: null });
  },
  openPalette(page: PalettePage = 'root', targets: string[] = state.contextIssues) {
    ui.set({ palette: page, paletteTargets: targets });
  },
};

export function useUi<T>(select: (s: UiState) => T): T {
  return useSyncExternalStore(ui.subscribe, () => select(state));
}

/** Per-browser preferences (layout choices etc.). Storage may be unavailable; fail soft. */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`ordo:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`ordo:${key}`, JSON.stringify(value));
  } catch {}
}
