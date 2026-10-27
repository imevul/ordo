import type {
  Bootstrap,
  Comment,
  CreateCommentInput,
  CreateIssueInput,
  Cycle,
  HistoryEntry,
  Issue,
  IssueDetail,
  IssueFilter,
  Label,
  Me,
  Notification,
  Project,
  SearchResults,
  Team,
  UpdateIssueInput,
} from '@ordo/shared';

/** An error answer from Ordo: the HTTP status, the API's error code and its message. */
export class OrdoError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'OrdoError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface OrdoOptions {
  /** Where Ordo runs, e.g. `https://ordo.example.com`. */
  url: string;
  /** A personal API key (`ordo_…`), from Settings → API keys. */
  token: string;
  /** Another fetch implementation (tests, proxies). */
  fetch?: typeof fetch;
}

/**
 * A client for one Ordo instance, acting as the key's owner.
 *
 * ```ts
 * const ordo = new Ordo({ url: 'https://ordo.example.com', token: process.env.ORDO_TOKEN! });
 * const acme = ordo.workspace('acme');
 * for await (const issue of acme.issues.all({ assigneeIds: ['me'] })) console.log(issue.identifier);
 * ```
 */
export class Ordo {
  readonly url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(opts: OrdoOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? globalThis.fetch;
  }

  /** Any API call; `path` is relative to `/api`. */
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.#fetch(`${this.url}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const err = (data && typeof data === 'object' ? data : {}) as {
        error?: string;
        message?: string;
        details?: unknown;
        // GraphQL answers errors in its own shape.
        errors?: { message: string; extensions?: { code?: string } }[];
      };
      const gql = err.errors?.[0];
      throw new OrdoError(
        res.status,
        err.error ?? gql?.extensions?.code ?? 'error',
        err.message ?? gql?.message ?? (res.statusText || `HTTP ${res.status}`),
        err.details ?? err.errors,
      );
    }
    return data as T;
  }

  /** The key's owner, with their workspaces. */
  me() {
    return this.request<Me>('GET', '/auth/me');
  }

  health() {
    return this.request<{ ok: boolean; version: string }>('GET', '/health');
  }

  /** Calls scoped to one workspace, by its URL slug. */
  workspace(slug: string) {
    return new WorkspaceClient(this, slug);
  }
}

export interface IssueQueryOptions {
  /** At most this many (default 2 000, at most 5 000). */
  limit?: number;
}

export class WorkspaceClient {
  readonly slug: string;
  readonly #ordo: Ordo;

  constructor(ordo: Ordo, slug: string) {
    this.#ordo = ordo;
    this.slug = slug;
  }

  /** Any workspace call; `path` is relative to `/api/w/<slug>`. */
  request<T = unknown>(method: string, path: string, body?: unknown) {
    return this.#ordo.request<T>(method, `/w/${encodeURIComponent(this.slug)}${path}`, body);
  }

  /** Everything small enough to load at once: members, teams with statuses, labels, projects, cycles… */
  bootstrap() {
    return this.request<Bootstrap>('GET', '/bootstrap');
  }

  teams() {
    return this.request<Team[]>('GET', '/teams');
  }

  projects() {
    return this.request<Project[]>('GET', '/projects');
  }

  cycles() {
    return this.request<Cycle[]>('GET', '/cycles');
  }

  labels() {
    return this.bootstrap().then((b): Label[] => b.labels);
  }

  /** Issues and projects matching words or an identifier, best first. */
  search(q: string) {
    return this.request<SearchResults>('GET', `/search?q=${encodeURIComponent(q)}`);
  }

  notifications() {
    return this.request<Notification[]>('GET', '/notifications');
  }

  /**
   * A GraphQL query or mutation (see docs/graphql.md). Resolves to `data`; GraphQL errors throw an
   * OrdoError with the first error's message and code, and `details` holding all of them.
   */
  async graphql<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.request<{
      data?: T;
      errors?: { message: string; extensions?: { code?: string } }[];
    }>('POST', '/graphql', { query, variables });
    if (res.errors?.length) {
      const first = res.errors[0]!;
      throw new OrdoError(200, first.extensions?.code ?? 'graphql', first.message, res.errors);
    }
    return res.data as T;
  }

  async *#allIssues(filter: IssueFilter, pageSize: number): AsyncGenerator<Issue> {
    let after: string | null = null;
    for (;;) {
      const page: Issue[] = await this.request<Issue[]>('POST', '/issues/query', {
        filter,
        limit: pageSize,
        after,
      });
      yield* page;
      if (page.length < pageSize) return;
      after = page.at(-1)!.id;
    }
  }

  readonly issues = {
    /** Issues matching a filter, in board order. */
    list: (filter: IssueFilter = {}, opts: IssueQueryOptions = {}) =>
      this.request<Issue[]>('POST', '/issues/query', { filter, limit: opts.limit }),

    /** Every issue matching a filter, fetched a page at a time. */
    all: (filter: IssueFilter = {}, opts: { pageSize?: number } = {}) =>
      this.#allIssues(filter, opts.pageSize ?? 1000),

    /** One issue in full, by id or identifier (`ENG-42`). */
    get: (idOrIdentifier: string) =>
      this.request<IssueDetail>('GET', `/issues/${encodeURIComponent(idOrIdentifier)}`),

    create: (input: CreateIssueInput) => this.request<Issue>('POST', '/issues', input),

    update: (idOrIdentifier: string, patch: UpdateIssueInput) =>
      this.request<Issue>('PATCH', `/issues/${encodeURIComponent(idOrIdentifier)}`, patch),

    /** Moves it to the trash (restorable for 30 days). */
    trash: (idOrIdentifier: string) =>
      this.request<{ ok: true }>('DELETE', `/issues/${encodeURIComponent(idOrIdentifier)}`),

    archive: (idOrIdentifier: string) =>
      this.request('POST', `/issues/${encodeURIComponent(idOrIdentifier)}/archive`),

    unarchive: (idOrIdentifier: string) =>
      this.request('POST', `/issues/${encodeURIComponent(idOrIdentifier)}/unarchive`),

    history: (idOrIdentifier: string) =>
      this.request<HistoryEntry[]>('GET', `/issues/${encodeURIComponent(idOrIdentifier)}/history`),

    comments: (idOrIdentifier: string) =>
      this.request<Comment[]>('GET', `/issues/${encodeURIComponent(idOrIdentifier)}/comments`),

    /** Markdown; `@username` mentions notify. */
    comment: (idOrIdentifier: string, input: CreateCommentInput) =>
      this.request<Comment>(
        'POST',
        `/issues/${encodeURIComponent(idOrIdentifier)}/comments`,
        input,
      ),

    link: (idOrIdentifier: string, link: { url: string; title?: string }) =>
      this.request('POST', `/issues/${encodeURIComponent(idOrIdentifier)}/links`, link),
  };
}
