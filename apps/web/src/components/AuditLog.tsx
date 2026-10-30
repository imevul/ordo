import { AUDIT_CATEGORIES, type AuditCategory, type AuditEntry } from '@ordo/shared';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { ChevronRight, Filter, Search, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.ts';
import { type Catalog, type Params, t } from '../i18n/index.ts';
import { roleLabel } from '../i18n/labels.ts';
import { longDate, relativeTime } from '../lib/format.ts';
import { Spinner } from './PageHeader.tsx';
import { Avatar } from './ui/Avatar.tsx';

/**
 * An audit log: filtered by kind of action, person, time and free text, grouped by day and paged
 * ("Load older"). Each entry opens to show what exactly changed. Used for a workspace's log and
 * the instance admin's; each says how to name people, targets and ids, and may add filters.
 */

export interface AuditActor {
  id: string;
  name: string;
  color?: string | null;
  avatarUrl?: string | null;
  /** How the name is shown, when it needs more than the name (a "removed" tag). */
  label?: ReactNode;
}

export interface AuditLogProps<E extends AuditEntry> {
  /** The API path, without query. */
  path: string;
  queryKey: readonly unknown[];
  /** A person menu, for logs with few enough people; otherwise people are picked from entries. */
  people?: { id: string; name: string }[];
  actor(e: E): AuditActor | null;
  /** The person, team or workspace an action was on, by name. */
  target(e: E): string | null;
  /** Whether to repeat the target on the entry's line (not for "changed workspace settings"). */
  targetInLine?(e: E): boolean;
  /** Names for ids that turn up in an entry's details. */
  nameOf(id: string): string | undefined;
  /** A tag on the entry's line, e.g. its workspace in the instance log. */
  context?(e: E): string | null;
  /** More filters: their query string, controls, whether one is set, and how to clear them. */
  extra?: { params: string; controls: ReactNode; active: boolean; clear(): void };
}

const PAGE = 50;
const RANGES = ['any', '1d', '7d', '30d', 'custom'] as const;
type Range = (typeof RANGES)[number];
const DAYS: Partial<Record<Range, number>> = { '1d': 1, '7d': 7, '30d': 30 };
const CATEGORIES = Object.keys(AUDIT_CATEGORIES) as AuditCategory[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

/** YYYY-MM-DD in local time, for grouping. */
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const auditSelectClass = 'input h-8 w-auto min-w-0 max-w-full py-0 text-[12.5px]';

export function AuditLog<E extends AuditEntry>(props: AuditLogProps<E>) {
  const { path, queryKey, people, extra } = props;
  const [category, setCategory] = useState<AuditCategory | ''>('');
  const [actor, setActor] = useState<{ id: string; name: string } | null>(null);
  const [range, setRange] = useState<Range>('any');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [open, setOpen] = useState<string | null>(null);

  const filters = useMemo(() => {
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (category) p.set('category', category);
    if (actor) p.set('actorId', actor.id);
    if (q) p.set('q', q);
    const days = DAYS[range];
    if (days) p.set('from', new Date(Date.now() - days * 86_400_000).toISOString());
    if (range === 'custom') {
      // Whole local days: from the start of `from` to the end of `to`.
      if (from) p.set('from', new Date(`${from}T00:00`).toISOString());
      if (to) {
        const end = new Date(`${to}T00:00`);
        end.setDate(end.getDate() + 1);
        p.set('to', end.toISOString());
      }
    }
    return [p.toString(), extra?.params].filter(Boolean).join('&');
  }, [category, actor, q, range, from, to, extra?.params]);
  const filtered = !!(category || actor || q || range !== 'any' || extra?.active);

  const query = useInfiniteQuery({
    queryKey: [...queryKey, filters],
    queryFn: ({ pageParam }) =>
      api.get<E[]>(
        `${path}?${filters}${pageParam ? `&before=${encodeURIComponent(pageParam.createdAt)}&beforeId=${pageParam.id}` : ''}`,
      ),
    initialPageParam: null as { createdAt: string; id: string } | null,
    getNextPageParam: (last) =>
      last.length < PAGE ? undefined : { createdAt: last.at(-1)!.createdAt, id: last.at(-1)!.id },
    placeholderData: keepPreviousData,
  });

  const entries = query.data?.pages.flat() ?? [];
  const today = localDay(new Date());
  const yesterday = localDay(new Date(Date.now() - 86_400_000));
  const groups: { day: string; label: string; items: E[] }[] = [];
  for (const e of entries) {
    const day = localDay(new Date(e.createdAt));
    if (groups.at(-1)?.day !== day) {
      const label =
        day === today
          ? t('workspaceSettings.audit.today')
          : day === yesterday
            ? t('workspaceSettings.audit.yesterday')
            : longDate(e.createdAt).split(' · ')[0]!;
      groups.push({ day, label, items: [] });
    }
    groups.at(-1)!.items.push(e);
  }

  const clear = () => {
    setCategory('');
    setActor(null);
    setRange('any');
    setFrom('');
    setTo('');
    setSearch('');
    extra?.clear();
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-[1_1_14rem]">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-index"
          />
          <input
            className="input h-8 py-0 pl-8 text-[12.5px]"
            placeholder={t('workspaceSettings.audit.search')}
            aria-label={t('workspaceSettings.audit.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {extra?.controls}
        <select
          className={auditSelectClass}
          aria-label={t('workspaceSettings.audit.category')}
          value={category}
          onChange={(e) => setCategory(e.target.value as AuditCategory | '')}
        >
          <option value="">{t('workspaceSettings.audit.categories.all')}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`workspaceSettings.audit.categories.${c}`)}
            </option>
          ))}
        </select>
        {people ? (
          <select
            className={auditSelectClass}
            aria-label={t('workspaceSettings.audit.person')}
            value={actor?.id ?? ''}
            onChange={(e) => {
              const p = people.find((x) => x.id === e.target.value);
              setActor(p ? { id: p.id, name: p.name } : null);
            }}
          >
            <option value="">{t('workspaceSettings.audit.anyone')}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          actor && (
            <button
              type="button"
              className="tag flex h-8 items-center gap-1.5"
              onClick={() => setActor(null)}
              aria-label={t('workspaceSettings.audit.removePerson', { name: actor.name })}
            >
              {actor.name} <X size={11} />
            </button>
          )
        )}
        <select
          className={auditSelectClass}
          aria-label={t('workspaceSettings.audit.when')}
          value={range}
          onChange={(e) => setRange(e.target.value as Range)}
        >
          {RANGES.map((r) => (
            <option key={r} value={r}>
              {t(`workspaceSettings.audit.ranges.${r}`)}
            </option>
          ))}
        </select>
        {range === 'custom' && (
          <span className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <input
              type="date"
              className={auditSelectClass}
              aria-label={t('workspaceSettings.audit.from')}
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
            <span aria-hidden>→</span>
            <input
              type="date"
              className={auditSelectClass}
              aria-label={t('workspaceSettings.audit.to')}
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </span>
        )}
        {filtered && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>
            <X size={12} /> {t('workspaceSettings.audit.clear')}
          </button>
        )}
      </div>

      {query.isLoading ? (
        <Spinner />
      ) : (
        <div className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
          {groups.map((g) => (
            <div key={g.day}>
              <div className="mt-4 mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase first:mt-0">
                {g.label}
              </div>
              {g.items.map((e) => (
                <AuditRow
                  key={e.id}
                  entry={e}
                  log={props}
                  open={open === e.id}
                  onToggle={() => setOpen(open === e.id ? null : e.id)}
                  onOnly={(a) => setActor({ id: a.id, name: a.name })}
                  only={actor?.id}
                />
              ))}
            </div>
          ))}
          {entries.length === 0 && (
            <p className="font-mono text-[12px] text-index">
              {filtered
                ? t('workspaceSettings.audit.noMatches')
                : t('workspaceSettings.audit.empty')}
            </p>
          )}
          {query.hasNextPage && (
            <button
              type="button"
              className="btn btn-ghost btn-sm mt-4"
              disabled={query.isFetchingNextPage}
              onClick={() => query.fetchNextPage()}
            >
              {t('workspaceSettings.audit.loadOlder')}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function AuditRow<E extends AuditEntry>({
  entry: e,
  log,
  open,
  onToggle,
  onOnly,
  only,
}: {
  entry: E;
  log: AuditLogProps<E>;
  open: boolean;
  onToggle: () => void;
  onOnly: (actor: AuditActor) => void;
  only?: string;
}) {
  const actor = log.actor(e);
  const target = log.target(e);
  const context = log.context?.(e);
  // Ids in the details read better as the people and teams they point to.
  const show = (v: unknown): string => {
    if (typeof v === 'string' && UUID.test(v)) return log.nameOf(v) ?? v;
    if (Array.isArray(v)) return v.map(show).join(', ');
    if (v && typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  // One level of nesting reads as dotted keys: settings.aiEnabled.
  const details = Object.entries(e.data)
    .flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.entries(v).map(([sub, inner]) => [`${k}.${sub}`, inner] as const)
        : [[k, v] as const],
    )
    .filter(([, v]) => v !== undefined && v !== null);

  return (
    <div className="border-b border-border-soft text-[13px]">
      <button
        type="button"
        className="flex w-full items-start gap-3 py-2.5 text-left hover:bg-[var(--wash-1)]"
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronRight
          size={12}
          className={`mt-1 flex-none text-index transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {actor ? (
          <Avatar
            name={actor.name}
            color={actor.color ?? 'var(--color-index)'}
            src={actor.avatarUrl ?? undefined}
            size={18}
          />
        ) : (
          <span className="h-[18px] w-[18px] flex-none bg-border" />
        )}
        <span className="min-w-0 flex-1">
          {actor?.label ?? (
            <span className="text-text">{actor?.name ?? t('shell.actor.someone')}</span>
          )}{' '}
          <span className="text-muted">{describeAudit(e)}</span>
          {target && (log.targetInLine?.(e) ?? true) && (
            <span className="text-text"> · {target}</span>
          )}
        </span>
        {context && <span className="tag max-w-40 flex-none truncate">{context}</span>}
        <span className="flex-none font-mono text-[11px] text-index" title={longDate(e.createdAt)}>
          {relativeTime(e.createdAt)}
        </span>
      </button>
      {open && (
        <div className="mb-3 ml-[42px] border-l border-border pl-3">
          <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1 font-mono text-[11.5px]">
            <dt className="text-index">{t('workspaceSettings.audit.time')}</dt>
            <dd className="break-all">{longDate(e.createdAt)}</dd>
            <dt className="text-index">{t('workspaceSettings.audit.action')}</dt>
            <dd className="break-all">{e.action}</dd>
            {e.ip && (
              <>
                <dt className="text-index">{t('workspaceSettings.audit.ip')}</dt>
                <dd className="break-all">{e.ip}</dd>
              </>
            )}
            {e.targetType && (
              <>
                <dt className="text-index">{t('workspaceSettings.audit.target')}</dt>
                <dd className="break-all">
                  {target ?? `${e.targetType}${e.targetId ? ` ${e.targetId}` : ''}`}
                </dd>
              </>
            )}
            {details.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-index">{k}</dt>
                <dd className="break-all whitespace-pre-wrap">{show(v)}</dd>
              </div>
            ))}
          </dl>
          {actor && only !== actor.id && (
            <button
              type="button"
              className="btn btn-ghost btn-sm mt-2"
              onClick={() => onOnly(actor)}
            >
              <Filter size={11} /> {t('workspaceSettings.audit.onlyPerson', { name: actor.name })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Human wording for audit actions: what the actor did, shown after their name. */
export function describeAudit(e: { action: string; data: Record<string, unknown> }) {
  const d = e.data;
  const str = (v: unknown) => String(v ?? '');
  const role = (v: unknown) =>
    v === 'owner' || v === 'admin' || v === 'member' || v === 'guest'
      ? roleLabel(v).toLowerCase()
      : String(v);
  const a = (key: AuditKey, params?: Params) => t(`workspaceSettings.audit.actions.${key}`, params);
  const named = (name: unknown, withName: AuditKey, without: AuditKey) =>
    name ? a(withName, { name: String(name) }) : a(without);
  switch (e.action) {
    case 'workspace.created':
      return a('workspaceCreated');
    case 'workspace.updated':
      return a('workspaceUpdated');
    case 'workspace.deleted':
      return a('workspaceDeleted');
    case 'member.joined':
      return a(
        d.via === 'domain'
          ? 'memberJoinedByDomain'
          : d.via === 'scim'
            ? 'memberJoinedByDirectory'
            : 'memberJoined',
      );
    case 'member.role_changed':
      return a('memberRoleChanged', { role: role(d.role) });
    case 'member.removed':
      return a(d.self ? 'memberLeft' : 'memberRemoved');
    case 'member.suspended':
      return a('memberSuspended');
    case 'member.unsuspended':
      return a('memberUnsuspended');
    case 'invite.created':
      return d.email
        ? a('inviteCreated', { email: String(d.email), role: role(d.role) })
        : a('inviteCreatedLink', { role: role(d.role) });
    case 'invite.revoked':
      return a('inviteRevoked');
    case 'invite.accepted':
      return a('inviteAccepted');
    case 'team.created':
      return a('teamCreated', { name: str(d.name) });
    case 'team.updated':
      return a('teamUpdated');
    case 'team.deleted':
      return a('teamDeleted', { name: str(d.name) });
    case 'team.member_added':
      return a('teamMemberAdded');
    case 'team.member_removed':
      return a('teamMemberRemoved');
    case 'team.member_role_changed':
      return a('teamMemberRoleChanged');
    case 'domain.added':
      return a('domainAdded', { domain: String(d.domain) });
    case 'domain.verified':
      return a('domainVerified', { domain: String(d.domain) });
    case 'domain.removed':
      return a('domainRemoved', { domain: String(d.domain) });
    case 'sso.provider_created':
      return a('ssoProviderCreated', { name: str(d.name) });
    case 'sso.provider_updated':
      return a('ssoProviderUpdated');
    case 'sso.provider_deleted':
      return a('ssoProviderDeleted', { name: str(d.name) });
    case 'auth.login':
      return d.method === 'sso'
        ? a('loginSso', { provider: String(d.provider ?? 'SSO') })
        : a('login');
    case 'auth.sso_bypass':
      return a('ssoBypass');
    case 'webhook.created':
      return a('webhookCreated', { url: str(d.url) });
    case 'webhook.updated':
      return a('webhookUpdated');
    case 'webhook.deleted':
      return a('webhookDeleted', { url: str(d.url) });
    case 'webhook.disabled':
      return a('webhookDisabled', { url: str(d.url) });
    case 'integration.created':
      return named(d.name ?? d.provider, 'integrationCreated', 'integrationCreatedUnnamed');
    case 'integration.updated':
      return a('integrationUpdated');
    case 'integration.deleted':
      return named(d.name ?? d.provider, 'integrationDeleted', 'integrationDeletedUnnamed');
    case 'auth.identity_linked':
      return d.provider
        ? a('identityLinked', { provider: String(d.provider) })
        : a('identityLinkedUnnamed');
    case 'auth.signup':
      return a('signup');
    case 'auth.login_failed':
      return a('loginFailed');
    case 'auth.logout':
      return a('logout');
    case 'auth.password_changed':
      return a('passwordChanged');
    case 'auth.email_changed':
      return a('emailChanged');
    case 'auth.2fa_enabled':
      return a('twoFactorEnabled');
    case 'auth.2fa_disabled':
      return a('twoFactorDisabled');
    case 'auth.session_revoked':
      return a('sessionRevoked');
    case 'auth.identity_unlinked':
      return a('identityUnlinked');
    case 'chat_account.linked':
      return a('chatAccountLinked');
    case 'chat_account.unlinked':
      return a('chatAccountUnlinked');
    case 'import.started':
      return a('importStarted');
    case 'import.completed':
      return a('importCompleted');
    case 'import.failed':
      return a('importFailed');
    case 'import.canceled':
      return a('importCanceled');
    case 'import.undone':
      return a('importUndone');
    case 'placeholder.merged':
      return a('placeholderMerged');
    case 'scim.token_created':
      return a('scimTokenCreated');
    case 'scim.token_deleted':
      return a('scimTokenDeleted');
    case 'scim.group_linked':
      return a('scimGroupLinked', { group: str(d.group), team: str(d.team) });
    case 'scim.group_unlinked':
      return a('scimGroupUnlinked', { group: str(d.group) });
    case 'auth.passkey_added':
      return a('passkeyAdded');
    case 'auth.passkey_removed':
      return a('passkeyRemoved');
    case 'api_key.created':
      return a('apiKeyCreated');
    case 'api_key.revoked':
      return a('apiKeyRevoked');
    case 'oauth.authorized':
      return a('oauthAuthorized');
    case 'oauth.revoked':
      return a('oauthRevoked');
    case 'workspace.ai_updated':
      return a('aiUpdated');
    case 'workspace.exported':
      return a('workspaceExported');
    case 'admin.user_updated':
      return a('accountUpdated');
    case 'admin.user_deleted':
      return a('accountDeleted');
    case 'admin.invite_created':
      return d.email
        ? a('siteInviteCreated', { email: String(d.email) })
        : a('siteInviteCreatedLink');
    case 'admin.invite_revoked':
      return a('siteInviteRevoked');
    case 'settings.updated':
      return a('settingsUpdated');
    case 'agent.created':
      return a('agentCreated', { name: str(d.name) });
    case 'agent.updated':
      return a('agentUpdated');
    case 'agent.disabled':
      return a('agentDisabled');
    case 'agent.key_created':
      return a('agentKeyCreated', { name: str(d.name) });
    case 'repository.created':
      return a('repositoryCreated', { name: str(d.name) });
    case 'repository.updated':
      return a('repositoryUpdated');
    case 'repository.deleted':
      return a('repositoryDeleted', { name: str(d.name) });
    default:
      return e.action;
  }
}

type AuditKey = keyof Catalog['workspaceSettings']['audit']['actions'];
