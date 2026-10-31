import type { Bootstrap, Comment, Issue, SyncChanges } from '@ordo/shared';
import {
  OfflineError,
  RejectedError,
  ResyncError,
  SignedOutError,
  type Transport,
} from './engine.ts';
import type { Op } from './outbox.ts';

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
    labels: [],
  }) as unknown as Bootstrap;

export class FakeServer {
  issues = new Map<string, Issue>();
  /** In the trash: out of the copy, but restorable. */
  trashed = new Map<string, Issue>();
  comments = new Map<string, Comment>();
  teams = ['team-1', 'team-2'];
  epoch = 1;
  minSeq = 0;
  log: { seq: number; kind: string; id: string }[] = [];
  offline = false;
  signedOut = false;
  calls: string[] = [];
  /** Refuses operations this returns true for (validation, permissions). */
  refuse: (op: Op) => boolean = () => false;
  /** Fails operations with a server error this many more times. */
  flaky = 0;
  sent: Op[] = [];

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
      send: async (op) => {
        reachable();
        if (this.signedOut) throw new SignedOutError('signed out');
        if (this.flaky > 0) {
          this.flaky--;
          throw new Error('500');
        }
        if (this.refuse(op)) throw new RejectedError('refused');
        this.sent.push(op);
        return this.apply(op);
      },
    };
  }

  /** What the real routes would do, roughly. */
  private apply(op: Op): unknown {
    switch (op.kind) {
      case 'issue.create': {
        const created = issue(op.issue.id, {
          title: op.issue.title,
          teamId: op.issue.teamId,
          identifier: `T-${this.issues.size + 1}`,
          number: this.issues.size + 1,
        });
        this.put(created);
        return created;
      }
      case 'issue.update': {
        const updated = op.ids.map((id) => {
          const next = { ...this.issues.get(id)!, ...(op.patch as object) } as Issue;
          this.put(next);
          return next;
        });
        return op.ids.length === 1 ? updated[0] : updated;
      }
      case 'issue.trash':
        for (const id of op.ids) {
          const i = this.issues.get(id);
          if (i) this.trashed.set(id, i);
          this.remove(id);
        }
        return { ok: true };
      case 'issue.restore':
        for (const id of op.ids) {
          const i = this.trashed.get(id);
          this.trashed.delete(id);
          if (i) this.put(i);
        }
        return { ok: true };
      case 'issue.move':
        return op.ids.map((id) => {
          const n = this.issues.size + 1;
          const key = op.teamId.toUpperCase();
          const moved = { ...this.issues.get(id)!, teamId: op.teamId, identifier: `${key}-${n}` };
          this.put(moved);
          return moved;
        });
      case 'comment.create': {
        const c = { ...comment(op.comment.id, op.comment.issueId, op.comment.body) };
        this.putComment(c);
        return c;
      }
      default:
        return { ok: true };
    }
  }
}
