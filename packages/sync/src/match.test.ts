import type { StateType } from '@ordo/shared';
import { describe, expect, it } from 'vitest';
import { matchesLocally, matchIssue } from './match.ts';
import { issue } from './testing.ts';

const types: Record<string, StateType> = { todo: 'unstarted', done: 'completed' };
const ctx = { userId: 'me', stateType: (id: string) => types[id] };

describe('matchIssue', () => {
  const mine = issue('a', { assigneeId: 'me', stateId: 'todo', labelIds: ['l1', 'l2'] });
  const nobodys = issue('b', { stateId: 'done', projectId: 'p1' });

  it('reads "me" and "none"', () => {
    expect(matchIssue(mine, { assigneeIds: ['me'] }, ctx)).toBe(true);
    expect(matchIssue(nobodys, { assigneeIds: ['me'] }, ctx)).toBe(false);
    expect(matchIssue(nobodys, { assigneeIds: ['none'] }, ctx)).toBe(true);
    expect(matchIssue(mine, { projectIds: ['none'] }, ctx)).toBe(true);
    expect(matchIssue(nobodys, { projectIds: ['none', 'p1'] }, ctx)).toBe(true);
    expect(matchIssue(mine, { creatorIds: ['me'] }, ctx)).toBe(true);
  });

  it('matches any of the labels, and state types', () => {
    expect(matchIssue(mine, { labelIds: ['l2', 'l9'] }, ctx)).toBe(true);
    expect(matchIssue(nobodys, { labelIds: ['l2'] }, ctx)).toBe(false);
    expect(matchIssue(mine, { stateTypes: ['unstarted', 'started'] }, ctx)).toBe(true);
    expect(matchIssue(nobodys, { stateTypes: ['unstarted'] }, ctx)).toBe(false);
  });

  it('leaves out trashed and archived issues unless asked', () => {
    const archived = issue('c', { archivedAt: '2026-01-02T00:00:00.000Z' });
    const trashed = issue('d', { deletedAt: '2026-01-02T00:00:00.000Z' });
    expect(matchIssue(archived, {}, ctx)).toBe(false);
    expect(matchIssue(archived, { archived: 'include' }, ctx)).toBe(true);
    expect(matchIssue(mine, { archived: 'only' }, ctx)).toBe(false);
    expect(matchIssue(trashed, {}, ctx)).toBe(false);
    expect(matchIssue(trashed, { trashed: true }, ctx)).toBe(true);
  });

  it('knows what the local copy can answer', () => {
    expect(matchesLocally({ assigneeIds: ['me'] })).toBe(true);
    expect(matchesLocally({ q: 'login' })).toBe(false);
    expect(matchesLocally({ trashed: true })).toBe(false);
    expect(matchesLocally({ subscribedBy: 'me' })).toBe(false);
    expect(matchesLocally({ archived: 'include' })).toBe(false);
    expect(matchesLocally({ blocked: false })).toBe(false);
    expect(
      matchesLocally({ or: [{ labelIds: ['l1'] }, { exclude: { hasPullRequest: true } }] }),
    ).toBe(false);
    expect(matchesLocally({ dueDate: { range: 'overdue' }, hasSubIssues: true })).toBe(true);
  });

  it('reads relative dates in the filter zone', () => {
    // Saturday 2026-10-31, 23:30 UTC: already Sunday in Stockholm.
    const now = new Date('2026-10-31T23:30:00Z');
    const at = { ...ctx, now };
    const late = issue('e', { stateId: 'todo', dueDate: '2026-10-30' });
    const lateDone = issue('f', { stateId: 'done', dueDate: '2026-10-30' });
    const sat = issue('g', { createdAt: '2026-10-31T22:00:00.000Z' });
    expect(matchIssue(late, { dueDate: { range: 'overdue' } }, at)).toBe(true);
    expect(matchIssue(lateDone, { dueDate: { range: 'overdue' } }, at)).toBe(false);
    expect(matchIssue(sat, { createdAt: { range: 'today' } }, at)).toBe(true);
    // 22:00 UTC is 23:00 Saturday in Stockholm, while "today" there is Sunday.
    const sthlm = { tz: 'Europe/Stockholm' } as const;
    expect(matchIssue(sat, { ...sthlm, createdAt: { range: 'today' } }, at)).toBe(false);
    // Weeks start on Monday by default; on Sunday when asked.
    expect(matchIssue(sat, { ...sthlm, createdAt: { range: 'thisWeek' } }, at)).toBe(true);
    expect(
      matchIssue(sat, { ...sthlm, weekStartsOn: 0, createdAt: { range: 'thisWeek' } }, at),
    ).toBe(false);
  });

  it('negates each "is not" condition and needs one "or" group', () => {
    const noDue = issue('h', { stateId: 'todo' });
    expect(matchIssue(noDue, { exclude: { dueDate: { range: 'today' } } }, ctx)).toBe(true);
    expect(matchIssue(mine, { exclude: { assigneeIds: ['me'] } }, ctx)).toBe(false);
    expect(matchIssue(mine, { exclude: { assigneeIds: ['me'], labelIds: ['l9'] } }, ctx)).toBe(
      false,
    );
    expect(
      matchIssue(mine, { or: [{ labelIds: ['l9'] }, { stateTypes: ['unstarted'] }] }, ctx),
    ).toBe(true);
    expect(matchIssue(nobodys, { or: [{ labelIds: ['l9'] }, { assigneeIds: ['me'] }] }, ctx)).toBe(
      false,
    );
    expect(matchIssue(mine, { estimate: { none: true } }, ctx)).toBe(true);
    expect(matchIssue(issue('i', { estimate: 3 }), { estimate: { max: 2 } }, ctx)).toBe(false);
  });
});
