import { describe, expect, it } from 'vitest';
import { patchIssue, toggleReaction } from './optimistic.ts';
import { issue } from './testing.ts';

const now = '2026-10-30T12:00:00.000Z';

describe('patchIssue', () => {
  const base = issue('a', { teamId: 't1', stateId: 's1', labelIds: ['l1', 'l2'] });

  it('sets what the patch gives and stamps updatedAt', () => {
    const next = patchIssue(base, { title: 'New', assigneeId: null, priority: undefined }, now);
    expect(next).toMatchObject({ title: 'New', assigneeId: null, priority: base.priority });
    expect(next.updatedAt).toBe(now);
    expect(base.title).not.toBe('New');
  });

  it('adds and removes labels without repeats', () => {
    expect(patchIssue(base, { addLabelIds: ['l2', 'l3'] }, now).labelIds).toEqual([
      'l1',
      'l2',
      'l3',
    ]);
    expect(patchIssue(base, { removeLabelIds: ['l1'] }, now).labelIds).toEqual(['l2']);
    expect(patchIssue(base, { labelIds: ['l9'] }, now).labelIds).toEqual(['l9']);
  });

  it('leaves team moves to the server', () => {
    expect(patchIssue(base, { teamId: 't2' }, now).teamId).toBe('t1');
  });
});

describe('toggleReaction', () => {
  const reactions = [
    { emoji: '👍', userIds: ['u1'] },
    { emoji: '🎉', userIds: ['me'] },
  ];

  it('adds to an existing emoji or starts a new one', () => {
    expect(toggleReaction(reactions, '👍', 'me', true)).toEqual([
      { emoji: '👍', userIds: ['u1', 'me'] },
      { emoji: '🎉', userIds: ['me'] },
    ]);
    expect(toggleReaction(reactions, '🚀', 'me', true).at(-1)).toEqual({
      emoji: '🚀',
      userIds: ['me'],
    });
  });

  it('removes, dropping emoji nobody reacts with any more', () => {
    expect(toggleReaction(reactions, '🎉', 'me', false)).toEqual([
      { emoji: '👍', userIds: ['u1'] },
    ]);
    expect(toggleReaction(reactions, '🎉', 'me', true)).toEqual(reactions);
  });
});
