import type {
  Bootstrap,
  Comment,
  Issue,
  SyncChanges,
  SyncIssuePage,
  SyncSnapshot,
} from '@ordo/shared';
import type { Meta, StoreWrite, SyncStore } from './store.ts';

/**
 * Keeps a local copy of one workspace up to date: loads it once (snapshot, then issues a page at
 * a time), then follows the server's change log. Reads come from memory, so screens never wait;
 * the store keeps the copy between visits and when offline.
 *
 * Framework-agnostic on purpose (the web app binds it to React; desktop and mobile apps can bind
 * it to theirs), and network-agnostic: it talks to the server through a `Transport`.
 */

export interface Transport {
  snapshot(): Promise<SyncSnapshot>;
  issues(after: string | null, limit: number): Promise<SyncIssuePage>;
  /** Throws `ResyncError` when the server says to start over (410). */
  changes(since: number, epoch: number): Promise<SyncChanges>;
  comments(issueId: string): Promise<Comment[]>;
}

/** The copy can't catch up from the log (new epoch, or too far behind): load it again. */
export class ResyncError extends Error {}
/** The server couldn't be reached. Transports throw it so the engine knows it's offline. */
export class OfflineError extends Error {}

export interface SyncState {
  /** There's a copy to show (from this session or an earlier one). */
  ready: boolean;
  /** The last request to the server got through. */
  online: boolean;
  /** Loading or catching up right now. */
  syncing: boolean;
  bootstrap: Bootstrap | null;
  issues: ReadonlyMap<string, Issue>;
  /** Bumped on every change, for memoising what's derived from the state. */
  version: number;
}

/** What a step changed, so other tabs can apply it too; `full` means "read the store again". */
export interface Delta extends StoreWrite {
  full?: boolean;
}

export interface EngineOptions {
  transport: Transport;
  store: SyncStore;
  pageSize?: number;
  /** Called with each change saved, for other tabs. */
  onDelta?: (delta: Delta) => void;
  onError?: (err: unknown) => void;
}

export class Engine {
  private meta: Meta | null = null;
  private state: SyncState = {
    ready: false,
    online: true,
    syncing: false,
    bootstrap: null,
    issues: new Map(),
    version: 0,
  };
  private listeners = new Set<() => void>();
  /** Comments of issues someone opened, by issue. */
  private comments = new Map<string, Map<string, Comment>>();
  private running: Promise<void> | null = null;
  private again = false;
  /** Only one tab talks to the server; the others apply what it shares. */
  leader = true;

  constructor(private opts: EngineOptions) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  get cursor() {
    return this.meta && { seq: this.meta.seq, epoch: this.meta.epoch };
  }

  private set(patch: Partial<Omit<SyncState, 'version'>>) {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    for (const l of this.listeners) l();
  }

  /** Reads the copy saved earlier, if any. */
  async open() {
    const { meta, bootstrap, issues } = await this.opts.store.read();
    this.meta = meta;
    this.comments.clear();
    this.set({
      ready: !!meta && !!bootstrap,
      bootstrap,
      issues: new Map(issues.map((i) => [i.id, i])),
    });
  }

  /** Brings the copy up to date. Calls while one runs share it, and ask for one more round. */
  sync(): Promise<void> {
    if (!this.leader) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      this.set({ syncing: true });
      try {
        do {
          this.again = false;
          await this.step();
        } while (this.again);
        if (!this.state.online) this.set({ online: true });
      } catch (err) {
        if (err instanceof OfflineError) this.set({ online: false });
        else this.opts.onError?.(err);
      } finally {
        this.running = null;
        this.set({ syncing: false });
      }
    })();
    return this.running;
  }

  /** A realtime event: catch up when it's ahead of the copy (or from another epoch). */
  notify(event: { seq?: number; epoch?: number }) {
    if (!this.meta) return;
    if (
      (event.epoch !== undefined && event.epoch !== this.meta.epoch) ||
      (event.seq !== undefined && event.seq > this.meta.seq)
    )
      void this.sync();
  }

  private async step() {
    if (!this.meta) return this.fullLoad();
    try {
      for (;;) {
        const changes = await this.opts.transport.changes(this.meta.seq, this.meta.epoch);
        await this.apply(changes);
        if (!changes.more) return;
      }
    } catch (err) {
      if (err instanceof ResyncError) return this.fullLoad();
      throw err;
    }
  }

  /** Loads everything; the old copy stays on screen until the new one is complete. */
  private async fullLoad() {
    const { transport, store, pageSize = 500 } = this.opts;
    const snap = await transport.snapshot();
    const issues: Issue[] = [];
    let after: string | null = null;
    do {
      const page = await transport.issues(after, pageSize);
      issues.push(...page.issues);
      after = page.next;
    } while (after);
    const meta: Meta = {
      workspaceId: snap.bootstrap.workspace.id,
      seq: snap.seq,
      epoch: snap.epoch,
      savedAt: new Date().toISOString(),
    };
    // One transaction: the old copy stays whole until the new one replaces it.
    await store.write({ meta, bootstrap: snap.bootstrap, replaceAll: true, issues });
    this.meta = meta;
    this.comments.clear();
    this.set({
      ready: true,
      bootstrap: snap.bootstrap,
      issues: new Map(issues.map((i) => [i.id, i])),
    });
    this.opts.onDelta?.({ full: true });
    // Whatever changed while the pages loaded comes next.
    this.again = true;
  }

  private async apply(changes: SyncChanges) {
    // Teams, members, labels… changed: load them again (the snapshot's position is ignored; the
    // log is still read from where this copy is).
    const bootstrap = changes.bootstrapChanged
      ? (await this.opts.transport.snapshot()).bootstrap
      : undefined;
    const deleted = new Set(changes.deletedIssueIds);
    if (bootstrap) {
      // Access may have shrunk: issues of teams that are out of sight go.
      const teams = new Set(bootstrap.teams.map((t) => t.id));
      for (const issue of [...this.state.issues.values(), ...changes.issues])
        if (!teams.has(issue.teamId)) deleted.add(issue.id);
    }
    const delta: Delta = {
      meta: {
        ...this.meta!,
        seq: changes.seq,
        epoch: changes.epoch,
        savedAt: new Date().toISOString(),
      },
      bootstrap,
      issues: changes.issues.filter((i) => !deleted.has(i.id)),
      deletedIssueIds: [...deleted],
      comments: changes.comments,
      deletedCommentIds: changes.deletedCommentIds,
    };
    await this.opts.store.write(delta);
    this.receive(delta);
    this.opts.onDelta?.(delta);
  }

  /** Applies a delta to memory: this tab's own, or one another tab saved and shared. */
  receive(delta: Delta) {
    if (delta.full) {
      void this.open();
      return;
    }
    if (delta.meta) this.meta = delta.meta;
    let issues: Map<string, Issue> | null = null;
    if (delta.issues?.length || delta.deletedIssueIds?.length) {
      issues = new Map(this.state.issues);
      for (const issue of delta.issues ?? []) issues.set(issue.id, issue);
      for (const id of delta.deletedIssueIds ?? []) issues.delete(id);
    }
    for (const c of delta.comments ?? []) this.comments.get(c.issueId)?.set(c.id, c);
    for (const id of delta.deletedCommentIds ?? [])
      for (const list of this.comments.values()) list.delete(id);
    this.set({
      ...(delta.bootstrap && { bootstrap: delta.bootstrap }),
      ...(issues && { issues }),
    });
  }

  /** An issue by id or identifier (ENG-12). */
  issue(idOrIdentifier: string): Issue | undefined {
    const byId = this.state.issues.get(idOrIdentifier);
    if (byId) return byId;
    const wanted = idOrIdentifier.toUpperCase();
    for (const issue of this.state.issues.values())
      if (issue.identifier.toUpperCase() === wanted) return issue;
    return undefined;
  }

  /** Comments kept for an issue, oldest first (from memory, else the store). */
  async commentsFor(issueId: string): Promise<Comment[]> {
    let list = this.comments.get(issueId);
    if (!list) {
      const saved = await this.opts.store.commentsFor(issueId);
      list = new Map(saved.map((c) => [c.id, c]));
      this.comments.set(issueId, list);
    }
    return [...list.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Comments fetched from the server: kept, replacing what was kept for the issue. */
  async saveComments(issueId: string, comments: Comment[]) {
    const before = await this.commentsFor(issueId);
    const ids = new Set(comments.map((c) => c.id));
    const delta: Delta = {
      comments,
      deletedCommentIds: before.filter((c) => !ids.has(c.id)).map((c) => c.id),
    };
    await this.opts.store.write(delta);
    this.comments.set(issueId, new Map(comments.map((c) => [c.id, c])));
    this.opts.onDelta?.(delta);
  }

  /** Forgets the copy (signing out, or this device no longer keeps one). */
  async clear() {
    await this.opts.store.clear();
    this.meta = null;
    this.comments.clear();
    this.set({ ready: false, bootstrap: null, issues: new Map() });
  }

  close() {
    this.listeners.clear();
    this.opts.store.close();
  }
}
