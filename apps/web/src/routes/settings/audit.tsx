import { AUDIT_CATEGORIES, type AuditCategory, type AuditEntry } from '@ordo/shared';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { ChevronRight, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, wsPath } from '../../api/client.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { ActorName } from '../../components/ui/ActorName.tsx';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { t } from '../../i18n/index.ts';
import { longDate, relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { SettingsCard } from './ui.tsx';
import { describeAudit } from './workspace.tsx';

/**
 * The workspace's audit log: filtered by kind of action, person, time and free text, grouped by
 * day, and paged ("Load older"). Each entry opens to show what exactly changed.
 */

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

/** YYYY-MM-DD in local time, for grouping and date inputs. */
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function AuditSection() {
  const ws = useWorkspace();
  const [category, setCategory] = useState<AuditCategory | ''>('');
  const [actorId, setActorId] = useState('');
  const [range, setRange] = useState<Range>('any');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [open, setOpen] = useState<string | null>(null);

  const filters = useMemo(() => {
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (category) p.set('category', category);
    if (actorId) p.set('actorId', actorId);
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
    return p.toString();
  }, [category, actorId, q, range, from, to]);
  const filtered = !!(category || actorId || q || range !== 'any');

  const query = useInfiniteQuery({
    queryKey: ['ws', ws.slug, 'audit', filters],
    queryFn: ({ pageParam }) =>
      api.get<AuditEntry[]>(
        wsPath(
          ws.slug,
          `/audit-log?${filters}${pageParam ? `&before=${encodeURIComponent(pageParam.createdAt)}&beforeId=${pageParam.id}` : ''}`,
        ),
      ),
    initialPageParam: null as { createdAt: string; id: string } | null,
    getNextPageParam: (last) =>
      last.length < PAGE ? undefined : { createdAt: last.at(-1)!.createdAt, id: last.at(-1)!.id },
    enabled: ws.isAdmin,
    placeholderData: keepPreviousData,
  });

  const people = useMemo(
    () =>
      [...ws.memberById.values()]
        .filter((p) => !p.placeholder)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [ws.memberById],
  );

  if (!ws.isAdmin) return <p className="text-muted">{t('workspaceSettings.audit.adminsOnly')}</p>;

  const entries = query.data?.pages.flat() ?? [];
  const today = localDay(new Date());
  const yesterday = localDay(new Date(Date.now() - 86_400_000));
  const dayLabel = (day: string, iso: string) =>
    day === today
      ? t('workspaceSettings.audit.today')
      : day === yesterday
        ? t('workspaceSettings.audit.yesterday')
        : longDate(iso).split(' · ')[0]!;
  const groups: { day: string; label: string; items: AuditEntry[] }[] = [];
  for (const e of entries) {
    const day = localDay(new Date(e.createdAt));
    if (groups.at(-1)?.day !== day)
      groups.push({ day, label: dayLabel(day, e.createdAt), items: [] });
    groups.at(-1)!.items.push(e);
  }

  const clear = () => {
    setCategory('');
    setActorId('');
    setRange('any');
    setFrom('');
    setTo('');
    setSearch('');
  };
  const select = 'input h-8 w-auto min-w-0 max-w-full py-0 text-[12.5px]';

  return (
    <SettingsCard
      title={t('workspaceSettings.audit.title')}
      description={t('workspaceSettings.audit.description')}
    >
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
        <select
          className={select}
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
        <select
          className={select}
          aria-label={t('workspaceSettings.audit.person')}
          value={actorId}
          onChange={(e) => setActorId(e.target.value)}
        >
          <option value="">{t('workspaceSettings.audit.anyone')}</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className={select}
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
              className={select}
              aria-label={t('workspaceSettings.audit.from')}
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
            <span aria-hidden>→</span>
            <input
              type="date"
              className={select}
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
                  open={open === e.id}
                  onToggle={() => setOpen(open === e.id ? null : e.id)}
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
    </SettingsCard>
  );
}

function AuditRow({
  entry: e,
  open,
  onToggle,
}: {
  entry: AuditEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const ws = useWorkspace();
  const actor = e.actorId ? ws.memberById.get(e.actorId) : null;
  const target =
    e.targetType === 'user' && e.targetId
      ? ws.memberById.get(e.targetId)?.name
      : e.targetType === 'team' && e.targetId
        ? ws.teamById.get(e.targetId)?.name
        : e.targetType === 'workspace' && e.targetId === ws.workspace.id
          ? ws.workspace.name
          : null;
  // Ids in the details read better as the people and teams they point to.
  const show = (v: unknown): string => {
    if (typeof v === 'string' && UUID.test(v))
      return ws.memberById.get(v)?.name ?? ws.teamById.get(v)?.name ?? v;
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
          <Avatar name={actor.name} color={actor.avatarColor} src={actor.avatarUrl} size={18} />
        ) : (
          <span className="h-[18px] w-[18px] flex-none bg-border" />
        )}
        <span className="min-w-0 flex-1">
          <ActorName person={actor} /> <span className="text-muted">{describeAudit(e)}</span>
          {target && e.targetType !== 'workspace' && <span className="text-text"> · {target}</span>}
        </span>
        <span className="flex-none font-mono text-[11px] text-index" title={longDate(e.createdAt)}>
          {relativeTime(e.createdAt)}
        </span>
      </button>
      {open && (
        <dl className="mb-3 ml-[42px] grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1 border-l border-border pl-3 font-mono text-[11.5px]">
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
      )}
    </div>
  );
}
