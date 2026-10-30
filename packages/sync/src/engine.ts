import type {
  Bootstrap,
  Comment,
  Issue,
  SyncChanges,
  SyncIssuePage,
  SyncSnapshot,
} from '@ordo/shared';
import {
  creates,
  needs,
  type Op,
  overlayComments,
  overlayIssues,
  type PendingOp,
} from './outbox.ts';
import type { Meta, StoreWrite, SyncStore } from './store.ts';

/**
 * Keeps a local copy of one workspace up to date: loads it once (snapshot, then issues a page at
 * a time), then follows the server's change log. Reads come from memory, so screens never wait;
 * the store keeps the copy between visits and when offline. Changes go into an outbox, show at
 * once on top of the server's data, and are sent in order when the server can be reached.
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
  /**
   * Sends one change. Resolves with what the server returned (an issue, issues, a comment…);
   * throws `RejectedError` when the server refuses it, `SignedOutError` without a session.
   */
  send(op: Op): Promise<unknown>;
}

/** The copy can't catch up from the log (new epoch, or too far behind): load it again. */
export class ResyncError extends Error {}
/** The server couldn't be reached. Transports throw it so the engine knows it's offline. */
export class OfflineError extends Error {}
/** The server refused a change (validation, permissions, gone): sending it again won't help. */
export class RejectedError extends Error {}
/** The session ended: nothing is sent until someone signs in again. */
export class SignedOutError extends Error {}

export interface SyncState {
  /** There's a copy to show (from this session or an earlier one). */
  ready: boolean;
  /** The last request to the server got through. */
  online: boolean;
  /** Loading or catching up right now. */
  syncing: boolean;
  /** Sending stopped: the session ended. */
  signedOut: boolean;
  bootstrap: Bootstrap | null;
  /** The server's issues with the outbox applied. */
  issues: ReadonlyMap<string, Issue>;
  /** Changes waiting to be sent. */
  waiting: number;
  /** Changes the server refused, kept until someone looks at them. */
  failed: readonly PendingOp[];
  /** Bumped on every change, for memoising what's derived from the state. */
  version: number;
}

/**
 * What a step changed, so other tabs can apply it too; `full` means "read the store again",
 * `outbox` that the queue changed.
 */
export interface Delta extends StoreWrite {
  full?: boolean;
  outbox?: boolean;
}

export interface EngineOptions {
  userId: string;
  transport: Transport;
  store: SyncStore;
  pageSize?: number;
  /** Called with each change saved, for other tabs. */
  onDelta?: (delta: Delta) => void;
  onError?: (err: unknown) => void;
}

type Waiter = { resolve: (result: unknown) => void; reject: (err: unknown) => void };

export class Engine {
  private meta: Meta | null = null;
  /** The server's issues, as last heard. */
  private base = new Map<string, Issue>();
  private pending: PendingOp[] = [];
  private state: SyncState = {
    ready: false,
    online: true,
    syncing: false,
    signedOut: false,
    bootstrap: null,
    issues: new Map(),
    waiting: 0,
    failed: [],
    version: 0,
  };
  private listeners = new Set<() => void>();
  /** The server's comments of issues someone opened, by issue. */
  private comments = new Map<string, Map<string, Comment>>();
  private running: Promise<void> | null = null;
  private again = false;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private waiters = new Map<number, Waiter>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
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

  /** Shows the server's data with the outbox on top. */
  private show(patch: Partial<Omit<SyncState, 'version'>> = {}) {
    const bootstrap = patch.bootstrap !== undefined ? patch.bootstrap : this.state.bootstrap;
    this.set({
      ...patch,
      issues: overlayIssues(this.base, this.pending, bootstrap, this.opts.userId),
      waiting: this.pending.filter((p) => !p.error).length,
      failed: this.pending.filter((p) => p.error),
    });
  }

  /** Reads the copy (and the outbox) saved earlier, if any. */
  async open() {
    const { store, userId } = this.opts;
    const [{ meta, bootstrap, issues }, outbox] = await Promise.all([store.read(), store.outbox()]);
    this.meta = meta;
    this.base = new Map(issues.map((i) => [i.id, i]));
    this.pending = outbox.filter((p) => p.userId === userId).sort((a, b) => a.key - b.key);
    this.comments.clear();
    this.show({ ready: !!meta && !!bootstrap, bootstrap });
  }

  /**
   * Sends what's waiting, then brings the copy up to date. Calls while one runs share it, and ask
   * for one more round.
   */
  sync(): Promise<void> {
    if (!this.leader) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      this.set({ syncing: true, signedOut: false });
      try {
        await this.flush();
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
  private async fullLoad(fetched?: SyncSnapshot) {
    const { transport, store, pageSize = 500 } = this.opts;
    const snap = fetched ?? (await transport.snapshot());
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
    // One transaction: the old copy stays whole until the new one replaces it. The outbox stays.
    await store.write({ meta, bootstrap: snap.bootstrap, replaceAll: true, issues });
    this.meta = meta;
    this.base = new Map(issues.map((i) => [i.id, i]));
    this.comments.clear();
    this.show({ ready: true, bootstrap: snap.bootstrap });
    this.opts.onDelta?.({ full: true });
    // Whatever changed while the pages loaded comes next.
    this.again = true;
  }

  private async apply(changes: SyncChanges) {
    // Teams, members, labels… changed: load them again (the snapshot's position is ignored; the
    // log is still read from where this copy is).
    const snap = changes.bootstrapChanged ? await this.opts.transport.snapshot() : undefined;
    const bootstrap = snap?.bootstrap;
    if (snap) {
      // A team came into sight: the log only has its issues changed since, so load everything.
      const known = new Set(this.state.bootstrap?.teams.map((t) => t.id));
      if (snap.bootstrap.teams.some((t) => !known.has(t.id))) return this.fullLoad(snap);
    }
    const deleted = new Set(changes.deletedIssueIds);
    if (bootstrap) {
      // Access may have shrunk: issues of teams that are out of sight go.
      const teams = new Set(bootstrap.teams.map((t) => t.id));
      for (const issue of [...this.base.values(), ...changes.issues])
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
    if (delta.outbox) {
      // Another tab queued or sent something: read the queue again, and send it if we lead.
      void this.opts.store.outbox().then((outbox) => {
        // Keep this tab's changes still being saved: the store doesn't have them yet.
        const unsaved = this.pending.filter((p) => p.key === Number.MAX_SAFE_INTEGER);
        this.pending = [...outbox.filter((p) => p.userId === this.opts.userId), ...unsaved].sort(
          (a, b) => a.key - b.key,
        );
        this.show();
        if (this.leader) void this.flush();
      });
    }
    if (delta.meta) this.meta = delta.meta;
    for (const issue of delta.issues ?? []) this.base.set(issue.id, issue);
    for (const id of delta.deletedIssueIds ?? []) this.base.delete(id);
    for (const c of delta.comments ?? []) this.comments.get(c.issueId)?.set(c.id, c);
    for (const id of delta.deletedCommentIds ?? [])
      for (const list of this.comments.values()) list.delete(id);
    this.show(delta.bootstrap ? { bootstrap: delta.bootstrap } : {});
  }

  // ─── changes made here ─────────────────────────────────────────────────

  /**
   * Queues a change and shows it at once. Resolves with the server's answer once it's sent, or
   * with undefined when it has to wait (offline, or another tab sends it); rejects when the
   * server refuses it.
   */
  mutate(op: Op): Promise<unknown> {
    // On screen before anything is saved: the store only makes it last.
    const entry: PendingOp = {
      key: Number.MAX_SAFE_INTEGER,
      op,
      userId: this.opts.userId,
      queuedAt: new Date().toISOString(),
      attempts: 0,
      error: null,
    };
    this.pending.push(entry);
    this.show();
    return (async () => {
      const { key: _unsaved, ...rest } = entry;
      try {
        entry.key = (await this.opts.store.enqueue(rest)).key;
      } catch (err) {
        // Not kept: take it off the screen, or everything queued after it waits behind it.
        this.pending = this.pending.filter((p) => p !== entry);
        this.show();
        throw err;
      }
      // Another tab's broadcast may have read it from the store meanwhile: keep one of it.
      this.pending = this.pending.filter((p) => p === entry || p.key !== entry.key);
      this.opts.onDelta?.({ outbox: true });
      if (!this.leader) return undefined;
      const done = new Promise((resolve, reject) =>
        this.waiters.set(entry.key, { resolve, reject }),
      );
      void this.flush();
      return done;
    })();
  }

  /** Sends the outbox in order, one change at a time. Calls meanwhile ask for another pass. */
  private flush(): Promise<void> {
    if (!this.leader) return Promise.resolve();
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    const run = (async () => {
      clearTimeout(this.retry);
      try {
        do {
          this.flushAgain = false;
          for (;;) {
            const next = this.pending.find((p) => !p.error);
            // Not saved yet: it's sent once it is (its own call to flush follows).
            if (!next || next.key === Number.MAX_SAFE_INTEGER) break;
            if (!(await this.sendOne(next))) return;
          }
        } while (this.flushAgain);
      } finally {
        // Whoever waits on a change that couldn't go yet hears it's queued.
        for (const [key, w] of this.waiters)
          if (this.pending.some((p) => p.key === key && !p.error)) {
            w.resolve(undefined);
            this.waiters.delete(key);
          }
      }
    })();
    this.flushing = run;
    void run.finally(() => {
      if (this.flushing === run) this.flushing = null;
    });
    return run;
  }

  /** Sends one change; false when sending has to stop for now. */
  private async sendOne(entry: PendingOp): Promise<boolean> {
    const { transport, store } = this.opts;
    let result: unknown;
    try {
      result = await transport.send(entry.op);
    } catch (err) {
      if (err instanceof OfflineError) {
        this.set({ online: false });
        this.later();
        return false;
      }
      if (err instanceof SignedOutError) {
        this.set({ signedOut: true });
        return false;
      }
      if (err instanceof RejectedError) {
        await this.refuse(entry, err.message);
        this.waiters.get(entry.key)?.reject(err);
        this.waiters.delete(entry.key);
        return true;
      }
      // The server had a problem: try again in a while.
      await store.updateOp({ ...entry, attempts: entry.attempts + 1 });
      entry.attempts++;
      this.later();
      return false;
    }
    await store.removeOp(entry.key);
    this.pending = this.pending.filter((p) => p.key !== entry.key);
    this.retries = 0;
    // What the server answered is the newest there is; keep it, so nothing flickers back.
    const answered = (Array.isArray(result) ? result : [result]).filter(
      (r): r is Issue => !!r && typeof r === 'object' && 'identifier' in r && 'teamId' in r,
    );
    if (answered.length) {
      await store.write({ issues: answered });
      for (const issue of answered) this.base.set(issue.id, issue);
    }
    if (entry.op.kind === 'issue.trash') for (const id of entry.op.ids) this.base.delete(id);
    this.show(this.state.online ? {} : { online: true });
    this.opts.onDelta?.({ outbox: true, issues: answered });
    this.waiters.get(entry.key)?.resolve(result);
    this.waiters.delete(entry.key);
    return true;
  }

  /** The server refused a change: keep it to show, and refuse what can't work without it. */
  private async refuse(entry: PendingOp, error: string) {
    const gone = new Set(creates(entry.op));
    const refused: PendingOp[] = [{ ...entry, error }];
    for (const p of this.pending) {
      if (p.key <= entry.key || p.error) continue;
      if (needs(p.op).some((id) => gone.has(id))) {
        refused.push({ ...p, error });
        for (const id of creates(p.op)) gone.add(id);
      }
    }
    for (const r of refused) {
      await this.opts.store.updateOp(r);
      this.waiters.get(r.key)?.reject(new RejectedError(error));
      this.waiters.delete(r.key);
    }
    const byKey = new Map(refused.map((r) => [r.key, r]));
    this.pending = this.pending.map((p) => byKey.get(p.key) ?? p);
    this.show();
    this.opts.onDelta?.({ outbox: true });
  }

  /** Backs off: 1 s, 2 s, 4 s… up to a minute. */
  private later() {
    clearTimeout(this.retry);
    const delay = Math.min(60_000, 1000 * 2 ** this.retries++);
    this.retry = setTimeout(() => void this.flush(), delay);
  }

  /** Forgets a refused change (after someone has seen it). */
  async dismiss(key: number) {
    await this.opts.store.removeOp(key);
    this.pending = this.pending.filter((p) => p.key !== key);
    this.show();
    this.opts.onDelta?.({ outbox: true });
  }

  // ─── reading ───────────────────────────────────────────────────────────

  /** An issue by id or identifier (ENG-12). */
  issue(idOrIdentifier: string): Issue | undefined {
    const byId = this.state.issues.get(idOrIdentifier);
    if (byId) return byId;
    const wanted = idOrIdentifier.toUpperCase();
    for (const issue of this.state.issues.values())
      if (issue.identifier.toUpperCase() === wanted) return issue;
    return undefined;
  }

  /** The server's comments kept for an issue (from memory, else the store). */
  private async baseComments(issueId: string): Promise<Map<string, Comment>> {
    let list = this.comments.get(issueId);
    if (!list) {
      const saved = await this.opts.store.commentsFor(issueId);
      list = new Map(saved.map((c) => [c.id, c]));
      this.comments.set(issueId, list);
    }
    return list;
  }

  /** An issue's comments as kept, with the outbox on top, oldest first. */
  async commentsFor(issueId: string): Promise<Comment[]> {
    return this.overlayComments(issueId, [...(await this.baseComments(issueId)).values()]);
  }

  /** Comments (from wherever) with the outbox on top. */
  overlayComments(issueId: string, comments: readonly Comment[]) {
    return overlayComments(issueId, comments, this.pending, this.opts.userId);
  }

  /** Comments fetched from the server: kept, replacing what was kept for the issue. */
  async saveComments(issueId: string, comments: Comment[]) {
    const before = await this.baseComments(issueId);
    const ids = new Set(comments.map((c) => c.id));
    const delta: Delta = {
      comments,
      deletedCommentIds: [...before.keys()].filter((id) => !ids.has(id)),
    };
    await this.opts.store.write(delta);
    this.comments.set(issueId, new Map(comments.map((c) => [c.id, c])));
    this.opts.onDelta?.(delta);
  }

  /** Forgets the copy (signing out, or this device no longer keeps one). */
  async clear() {
    await this.opts.store.clear();
    this.meta = null;
    this.base.clear();
    this.pending = [];
    this.comments.clear();
    this.show({ ready: false, bootstrap: null });
  }

  close() {
    clearTimeout(this.retry);
    this.listeners.clear();
    this.opts.store.close();
  }
}
