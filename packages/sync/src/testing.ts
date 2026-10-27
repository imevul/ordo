import type { Bootstrap, Comment, Issue, SyncChanges } from '@ordo/shared';
import { OfflineError, ResyncError, type Transport } from './engine.ts';

/**
 * A pretend server for the package's tests: a workspace's issues and comments, a change log and
 * an epoch, behind the same `Transport` the engine uses. Not exported from the package.
 */

export const issue = (id: string, extra: Partial<Issue> = {}): Issue => ({
  id,
  identifier: `T-${id}`,
  number: 1,
  teamId: 'team-1',
  title: `Issue ${id}`,
  description: '',
  stateId: 'state-todo',
  priority: 0,
  assigneeId: null,
  creatorId: 'me',
  projectId: null,
  milestoneId: null,
  cycleId: null,
  parentId: null,
  estimate: null,
  dueDate: null,
  sortOrder: 0,
  labelIds: [],
  subIssueCount: 0,
  completedSubIssueCount: 0,
  startedAt: null,
  completedAt: null,
  canceledAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  slaBreachesAt: null,
  archivedAt: null,
  ...extra,
});

export const comment = (id: string, issueId: string, body = 'hi'): Comment => ({
  id,
  issueId,
  authorId: 'me',
  parentId: null,
  body,
  createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
  updatedAt: '2026-01-01T00:00:00.000Z',
  editedAt: null,
  reactions: [],
});

const bootstrapFor = (teams: string[]) =>
  ({
    workspace: { id: 'ws-1', name: 'W', slug: 'w' },
    teams: teams.map((id) => ({ id, name: id, key: id.toUpperCase() })),
  }) as unknown as Bootstrap;

export class FakeServer {
  issues = new Map<string, Issue>();
  comments = new Map<string, Comment>();
  teams = ['team-1', 'team-2'];
  epoch = 1;
  minSeq = 0;
  log: { seq: number; kind: string; id: string }[] = [];
  offline = false;
  calls: string[] = [];

  get seq() {
    return this.log.at(-1)?.seq ?? this.minSeq;
  }

  private logChange(kind: string, id: string) {
    this.log.push({ seq: this.seq + 1, kind, id });
  }

  put(i: Issue) {
    this.issues.set(i.id, i);
    this.logChange('issue', i.id);
  }
  remove(id: string) {
    this.issues.delete(id);
    this.logChange('issue', id);
  }
  putComment(c: Comment) {
    this.comments.set(c.id, c);
    this.logChange('comment', c.id);
  }
  changeTeams(teams: string[]) {
    this.teams = teams;
    this.logChange('team', 'x');
  }
  newEpoch() {
    this.epoch++;
    this.minSeq = this.seq;
    this.log = [];
  }

  transport(pageLimit = 1000): Transport {
    const reachable = () => {
      if (this.offline) throw new OfflineError('offline');
    };
    return {
      snapshot: async () => {
        reachable();
        this.calls.push('snapshot');
        return { seq: this.seq, epoch: this.epoch, bootstrap: bootstrapFor(this.teams) };
      },
      issues: async (after, limit) => {
        reachable();
        this.calls.push('issues');
        const all = [...this.issues.values()]
          .filter((i) => this.teams.includes(i.teamId))
          .sort((a, b) => a.id.localeCompare(b.id))
          .filter((i) => !after || i.id > after);
        const page = all.slice(0, limit);
        return { issues: page, next: page.length === limit ? page.at(-1)!.id : null };
      },
      changes: async (since, epoch): Promise<SyncChanges> => {
        reachable();
        this.calls.push(`changes:${since}`);
        if (epoch !== this.epoch || since < this.minSeq) throw new ResyncError();
        const rows = this.log.filter((r) => r.seq > since).slice(0, pageLimit);
        const ids = (kind: string) => [
          ...new Set(rows.filter((r) => r.kind === kind).map((r) => r.id)),
        ];
        const visible = ids('issue')
          .map((id) => this.issues.get(id))
          .filter((i): i is Issue => !!i && this.teams.includes(i.teamId));
        const comments = ids('comment')
          .map((id) => this.comments.get(id))
          .filter((c): c is Comment => !!c);
        return {
          seq: rows.at(-1)?.seq ?? since,
          epoch: this.epoch,
          more: rows.length === pageLimit && rows.at(-1)!.seq < this.seq,
          issues: visible,
          deletedIssueIds: ids('issue').filter((id) => !visible.some((i) => i.id === id)),
          comments,
          deletedCommentIds: ids('comment').filter((id) => !this.comments.has(id)),
          bootstrapChanged: rows.some((r) => r.kind === 'team'),
          kinds: [],
        };
      },
      comments: async (issueId) => {
        reachable();
        return [...this.comments.values()].filter((c) => c.issueId === issueId);
      },
    };
  }
}
