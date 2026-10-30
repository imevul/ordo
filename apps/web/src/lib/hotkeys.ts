import { useEffect, useRef } from 'react';

/**
 * Global keyboard shortcuts. Bindings are strings like "c", "shift+a", "mod+k" or
 * two-key sequences like "g i". A key in brackets is the physical key (`KeyboardEvent.code`):
 * "mod+shift+[Period]" is the same key on every layout, where "mod+>" only works where `>` is
 * Shift+`.` (not on Nordic ones). Shortcuts never fire while typing in a field unless
 * `allowInInput` is set, and only the topmost scope (e.g. an open modal) receives them.
 */
type Handler = (e: KeyboardEvent) => void;
export interface Binding {
  keys: string[];
  handler: React.RefObject<Handler>;
  scope: string;
  allowInInput: boolean;
}

/** A plain key that may start a sequence, remembered with the scope it was pressed in. */
export interface PendingKey {
  key: string;
  at: number;
  scope: string;
}

export const SEQUENCE_TIMEOUT_MS = 900;

const bindings = new Set<Binding>();
const scopeStack: string[] = ['app'];
let sequence: PendingKey | null = null;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

type KeyInfo = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

/** The event as a chord by character ("mod+>") and by physical key ("mod+shift+[Period]"). */
export function chords(e: KeyInfo): [string, string] {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  const key = e.key.toLowerCase();
  // Shifted punctuation ("?") already encodes shift; letters, digits and named keys do not.
  const shift = e.shiftKey && (/^[a-z0-9]$/.test(key) || key.length > 1);
  const byKey = [...parts, ...(shift ? ['shift'] : []), key].join('+');
  const byCode = [...parts, ...(e.shiftKey ? ['shift'] : []), `[${e.code}]`].join('+');
  return [byKey, byCode];
}

/**
 * Picks the binding for a keypress. Only bindings in the active scope count. A completed
 * sequence ("g i") beats a single-key binding for its second key ("i") regardless of
 * registration order, since the prefix alone does nothing. A prefix pressed in another
 * scope, or too long ago, is ignored. Among bindings for the same keys, the newest wins.
 */
export function resolveHotkey(
  list: readonly Binding[],
  press: { chord: string; code?: string; scope: string; typing: boolean; now: number },
  pending: PendingKey | null,
): { binding: Binding | null; pending: PendingKey | null } {
  const { chord: c, code, scope, typing, now } = press;
  const active = list.filter((b) => b.scope === scope && (!typing || b.allowInInput)).reverse();
  const seq =
    pending && pending.scope === scope && now - pending.at < SEQUENCE_TIMEOUT_MS
      ? `${pending.key} ${c}`
      : null;
  const binding =
    (seq && active.find((b) => b.keys.includes(seq))) ||
    active.find((b) => b.keys.includes(c) || (!!code && b.keys.includes(code))) ||
    null;
  // Remember unbound single plain keys as potential sequence starters ("g" in "g i").
  const next = !binding && !typing && c.length === 1 ? { key: c, at: now, scope } : null;
  return { binding, pending: next };
}

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return;
  const [chord, code] = chords(e);
  const press = {
    chord,
    code,
    scope: scopeStack[scopeStack.length - 1]!,
    typing: isTyping(e),
    now: Date.now(),
  };
  const { binding, pending } = resolveHotkey([...bindings], press, sequence);
  sequence = pending;
  if (binding) {
    e.preventDefault();
    binding.handler.current?.(e);
  }
}

if (typeof window !== 'undefined') window.addEventListener('keydown', onKeyDown);

export function useHotkey(
  keys: string | string[],
  handler: Handler,
  opts: { scope?: string; allowInInput?: boolean; enabled?: boolean } = {},
) {
  const ref = useRef(handler);
  ref.current = handler;
  const list = Array.isArray(keys) ? keys : [keys];
  const id = list.join('|');
  const { scope = 'app', allowInInput = false, enabled = true } = opts;
  useEffect(() => {
    if (!enabled) return;
    const b: Binding = { keys: id.split('|'), handler: ref, scope, allowInInput };
    bindings.add(b);
    return () => {
      bindings.delete(b);
    };
  }, [id, scope, allowInInput, enabled]);
}

/** Pushes a hotkey scope while mounted (modals use this to capture keys). */
export function useHotkeyScope(scope: string, active = true) {
  useEffect(() => {
    if (!active) return;
    // A prefix pressed before a modal opened or closed must not combine with the next key.
    scopeStack.push(scope);
    sequence = null;
    return () => {
      const i = scopeStack.lastIndexOf(scope);
      if (i >= 0) scopeStack.splice(i, 1);
      sequence = null;
    };
  }, [scope, active]);
}
