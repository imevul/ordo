import { describe, expect, it } from 'vitest';
import {
  type Binding,
  chords,
  type PendingKey,
  resolveHotkey,
  SEQUENCE_TIMEOUT_MS,
} from './hotkeys.ts';

const bind = (keys: string | string[], opts: Partial<Binding> = {}): Binding => ({
  keys: Array.isArray(keys) ? keys : [keys],
  handler: { current: () => {} },
  scope: 'app',
  allowInInput: false,
  ...opts,
});

const press = (chord: string, over: { scope?: string; typing?: boolean; now?: number } = {}) => ({
  chord,
  scope: 'app',
  typing: false,
  now: 1000,
  ...over,
});

const g = (over: Partial<PendingKey> = {}): PendingKey => ({
  key: 'g',
  at: 900,
  scope: 'app',
  ...over,
});

describe('resolveHotkey', () => {
  const goInbox = bind('g i');
  const assignMe = bind('i');

  it('lets a completed sequence beat a single key in either registration order', () => {
    for (const list of [
      [goInbox, assignMe],
      [assignMe, goInbox],
    ]) {
      expect(resolveHotkey(list, press('i'), g()).binding).toBe(goInbox);
    }
  });

  it('fires the single key when no prefix is pending', () => {
    expect(resolveHotkey([goInbox, assignMe], press('i'), null).binding).toBe(assignMe);
  });

  it('remembers an unbound plain key as a prefix, with its scope', () => {
    const r = resolveHotkey([goInbox, assignMe], press('g'), null);
    expect(r.binding).toBeNull();
    expect(r.pending).toEqual({ key: 'g', at: 1000, scope: 'app' });
  });

  it('clears the prefix once a binding fires', () => {
    expect(resolveHotkey([goInbox], press('i'), g()).pending).toBeNull();
    expect(resolveHotkey([assignMe], press('i'), g()).pending).toBeNull();
  });

  it('drops a prefix pressed in another scope', () => {
    const modalI = bind('i', { scope: 'modal' });
    const modalGoInbox = bind('g i', { scope: 'modal' });
    const list = [goInbox, assignMe, modalI, modalGoInbox];
    expect(resolveHotkey(list, press('i', { scope: 'modal' }), g()).binding).toBe(modalI);
    expect(resolveHotkey(list, press('i'), g({ scope: 'modal' })).binding).toBe(assignMe);
  });

  it('drops a prefix after the timeout', () => {
    const late = press('i', { now: 900 + SEQUENCE_TIMEOUT_MS });
    expect(resolveHotkey([goInbox, assignMe], late, g()).binding).toBe(assignMe);
  });

  it('ignores bindings outside the active scope', () => {
    expect(resolveHotkey([goInbox], press('i', { scope: 'modal' }), g()).binding).toBeNull();
  });

  it('skips bindings that do not allow input while typing, and never starts a prefix', () => {
    const palette = bind('mod+k', { allowInInput: true });
    expect(resolveHotkey([assignMe], press('i', { typing: true }), null)).toEqual({
      binding: null,
      pending: null,
    });
    expect(resolveHotkey([palette], press('mod+k', { typing: true }), null).binding).toBe(palette);
    expect(resolveHotkey([goInbox], press('g', { typing: true }), null).pending).toBeNull();
  });

  it('picks the newest binding among ones for the same keys', () => {
    const older = bind('s');
    const newer = bind('s');
    expect(resolveHotkey([older, newer], press('s'), null).binding).toBe(newer);
  });

  it('matches a binding by physical key', () => {
    const copyBranch = bind('mod+shift+[Period]');
    const nordic = { ...press('mod+:'), code: 'mod+shift+[Period]' };
    expect(resolveHotkey([copyBranch], nordic, null).binding).toBe(copyBranch);
    expect(resolveHotkey([copyBranch], press('mod+:'), null).binding).toBeNull();
  });
});

const key = (k: string, code: string, mods: { mod?: boolean; shift?: boolean } = {}) =>
  chords({
    key: k,
    code,
    metaKey: false,
    ctrlKey: !!mods.mod,
    altKey: false,
    shiftKey: !!mods.shift,
  });

describe('chords', () => {
  it('names keys by character', () => {
    expect(key('k', 'KeyK', { mod: true })[0]).toBe('mod+k');
    expect(key('A', 'KeyA', { shift: true })[0]).toBe('shift+a');
    expect(key('?', 'Slash', { shift: true })[0]).toBe('?');
  });

  it('names the physical key the same on every layout', () => {
    // Mod Shift . on US English types ">", on Swedish and Norwegian ":".
    const us = key('>', 'Period', { mod: true, shift: true });
    const nordic = key(':', 'Period', { mod: true, shift: true });
    expect(us[1]).toBe('mod+shift+[Period]');
    expect(nordic[1]).toBe('mod+shift+[Period]');
    expect(nordic[0]).toBe('mod+:');
  });
});
