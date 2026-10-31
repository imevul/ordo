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

  it('drafts a new issue with the status and assignee the server would give it', () => {
    const t3 = {
      id: 't3',
      key: 'THR',
      defaultStateId: null,
      private: true,
      memberIds: ['me'],
      states: [
        state('s3-doing', 't3', 'started', 0),
        state('s3-later', 't3', 'unstarted', 2),
        state('s3-todo', 't3', 'unstarted', 1),
        state('s3-triage', 't3', 'triage', 3),
      ],
    };
    const people = {
      ...bootstrap,
      teams: [...bootstrap.teams, t3],
      workspace: { settings: { defaultAssigneeId: 'me' } },
      members: [
        { id: 'me', role: 'member' },
        { id: 'pat', role: 'member' },
      ],
      projects: [{ id: 'p-pat', defaultAssignee: 'pat', milestones: [{ id: 'm1' }] }],
    } as unknown as Bootstrap;
    const draft = (input: Partial<Extract<Op, { kind: 'issue.create' }>['issue']>) =>
      overlayIssues(
        new Map(),
        queued({ kind: 'issue.create', issue: { id: 'n', teamId: 't3', title: 'New', ...input } }),
        people,
        'me',
      ).get('n');
    // No default and no backlog: the first unstarted status by position.
    expect(draft({})).toMatchObject({ stateId: 's3-todo', assigneeId: 'me' });
    // Pat can't see the private team, so the project's choice doesn't stick.
    expect(draft({ milestoneId: 'm1' })).toMatchObject({ assigneeId: null });
    expect(draft({ assigneeId: null })).toMatchObject({ assigneeId: null });
    expect(draft({ stateId: 's3-triage' })).toMatchObject({ assigneeId: null });
    expect(draft({ teamId: 't2' })).toMatchObject({ stateId: 's2-backlog', assigneeId: 'me' });
  });
});
