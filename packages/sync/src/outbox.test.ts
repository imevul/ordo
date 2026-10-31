import type { Bootstrap } from '@ordo/shared';
import { describe, expect, it } from 'vitest';
import { type Op, overlayIssue, overlayIssues, type PendingOp } from './outbox.ts';
import { issue } from './testing.ts';

const queued = (...ops: Op[]): PendingOp[] =>
  ops.map((op, key) => ({
    key,
    op,
    userId: 'me',
    queuedAt: '2026-02-01T00:00:00.000Z',
    attempts: 0,
    error: null,
  }));

const state = (id: string, teamId: string, type: string, position = 0) => ({
  id,
  teamId,
  type,
  position,
});
const bootstrap = {
  teams: [
    { id: 't1', key: 'ONE', states: [state('s1-todo', 't1', 'unstarted')] },
    {
      id: 't2',
      key: 'TWO',
      defaultStateId: 's2-backlog',
      states: [
        state('s2-backlog', 't2', 'backlog'),
        state('s2-later', 't2', 'unstarted', 2),
        state('s2-todo', 't2', 'unstarted', 1),
      ],
    },
  ],
  labels: [
    { id: 'l-any', teamId: null },
    { id: 'l-one', teamId: 't1' },
  ],
} as unknown as Bootstrap;

describe('overlay', () => {
  it('moves an issue as the server will: same kind of status, no cycle, no old team labels', () => {
    const a = issue('a', {
      teamId: 't1',
      stateId: 's1-todo',
      cycleId: 'c1',
      labelIds: ['l-any', 'l-one'],
    });
    const out = overlayIssue(
      a,
      queued({ kind: 'issue.move', ids: ['a'], teamId: 't2' }),
      bootstrap,
    );
    expect(out).toMatchObject({
      teamId: 't2',
      stateId: 's2-todo',
      cycleId: null,
      labelIds: ['l-any'],
      identifier: 'T-a',
    });
  });

  it('brings back what was trashed and then restored', () => {
    const base = new Map([['a', issue('a')]]);
    const trashed = queued({ kind: 'issue.trash', ids: ['a'] });
    expect(overlayIssues(base, trashed, null, 'me').has('a')).toBe(false);
    const undone = queued(
      { kind: 'issue.trash', ids: ['a'] },
      { kind: 'issue.update', ids: ['a'], patch: { title: 'Lost' } },
      { kind: 'issue.restore', ids: ['a'] },
    );
    expect(overlayIssues(base, undone, null, 'me').get('a')).toMatchObject({
      title: 'Issue a',
      deletedAt: null,
    });
  });

  it('restores an issue from the trash that the copy holds', () => {
    const base = new Map([['a', issue('a', { deletedAt: '2026-01-02T00:00:00.000Z' })]]);
    const out = overlayIssues(base, queued({ kind: 'issue.restore', ids: ['a'] }), null, 'me');
    expect(out.get('a')!.deletedAt).toBeNull();
  });
});
