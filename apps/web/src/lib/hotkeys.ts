import { useEffect, useRef } from 'react';

/**
 * Global keyboard shortcuts. Bindings are strings like "c", "shift+a", "mod+k" or
 * two-key sequences like "g i". Shortcuts never fire while typing in a field unless
 * `allowInInput` is set, and only the topmost scope (e.g. an open modal) receives them.
 */
type Handler = (e: KeyboardEvent) => void;
interface Binding {
  keys: string[];
  handler: React.RefObject<Handler>;
  scope: string;
  allowInInput: boolean;
}

const bindings = new Set<Binding>();
const scopeStack: string[] = ['app'];
let sequence: { key: string; at: number } | null = null;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

function chord(e: KeyboardEvent) {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  const key = e.key.toLowerCase();
  // Shifted punctuation ("?") already encodes shift; letters, digits and named keys do not.
  if (e.shiftKey && (/^[a-z0-9]$/.test(key) || key.length > 1)) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return;
  const scope = scopeStack[scopeStack.length - 1];
  const c = chord(e);
  const typing = isTyping(e);
  const now = Date.now();
  const seq = sequence && now - sequence.at < 900 ? `${sequence.key} ${c}` : null;

  for (const b of [...bindings].reverse()) {
    if (b.scope !== scope) continue;
    if (typing && !b.allowInInput) continue;
    if ((seq && b.keys.includes(seq)) || b.keys.includes(c)) {
      e.preventDefault();
      sequence = null;
      b.handler.current?.(e);
      return;
    }
  }
  // Remember single plain keys as potential sequence starters ("g" in "g i").
  sequence = !typing && c.length === 1 ? { key: c, at: now } : null;
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
    scopeStack.push(scope);
    return () => {
      const i = scopeStack.lastIndexOf(scope);
      if (i >= 0) scopeStack.splice(i, 1);
    };
  }, [scope, active]);
}
