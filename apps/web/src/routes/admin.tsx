import type { AiSettings, InstanceSettingEntry } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Ban, KeyRound, RotateCcw, Shield, Trash2, UserCheck } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api/client.ts';
import { useMe } from '../api/queries.ts';
import { OrdoMark } from '../components/icons.tsx';
import { PageHeader, Sep, Spinner } from '../components/PageHeader.tsx';
import { confirmDialog } from '../components/ui/Modal.tsx';
import { getLocale, INTL_TAG, t } from '../i18n/index.ts';
import { relativeTime, shortDate } from '../lib/format.ts';

/**
 * The instance administrator's area: every user and workspace on this Ordo, instance settings,
 * background jobs and health. Lives outside any workspace.
 */

const SECTIONS = [
  'overview',
  'users',
  'workspaces',
  'domains',
  'settings',
  'jobs',
  'audit',
] as const;
type Section = (typeof SECTIONS)[number];
const sectionLabel = (s: Section) => t(`admin.sections.${s}`);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

/** Whichever of `forms` is known, else the raw value (the API may add new ones). */
const known = <K extends string>(value: string, forms: readonly K[], label: (k: K) => string) =>
  (forms as readonly string[]).includes(value) ? label(value as K) : value;

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="section-label mb-2">{title}</div>
      {description && <p className="mb-4 text-[13px] text-muted">{description}</p>}
      {children}
    </section>
  );
}

export function AdminPage() {
  const { section } = useParams({ from: '/admin/$section' });
  const me = useMe();
  if (me.isLoading) return <Spinner label={t('auth.booting')} />;
  if (!me.data) return <Navigate to="/login" search={{ redirect: `/admin/${section}` }} />;
  if (!me.data.isInstanceAdmin) return <Navigate to="/" />;
  const current = SECTIONS.find((s) => s === section) ?? SECTIONS[0];
  const back = me.data.workspaces[0];

  return (
    <div className="flex h-full">
      <nav
        className="hidden w-56 flex-none flex-col border-r border-border-soft bg-surface p-3 md:flex"
        aria-label={t('admin.navLabel')}
      >
        <div className="mb-6 flex h-9 items-center px-2">
          <OrdoMark />
          <span className="ml-2 font-mono text-[10.5px] tracking-[0.16em] text-primary uppercase">
            {t('admin.brand')}
          </span>
        </div>
        {SECTIONS.map((s) => (
          <Link
            key={s}
            to="/admin/$section"
            params={{ section: s }}
            className={`nav-item ${s === current ? 'active' : ''}`}
          >
            {sectionLabel(s)}
          </Link>
        ))}
        {back && (
          <Link to="/$slug" params={{ slug: back.slug }} className="nav-item mt-auto">
            <ArrowLeft size={14} />
            <span className="min-w-0 truncate">{t('admin.backTo', { name: back.name })}</span>
          </Link>
        )}
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          kicker={
            <>
              {t('admin.kicker')}
              <Sep />
              {sectionLabel(current)}
            </>
          }
          title={sectionLabel(current)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-6 py-8">
            {current === 'overview' && <Overview />}
            {current === 'users' && <Users myId={me.data.id} />}
            {current === 'workspaces' && <Workspaces />}
            {current === 'domains' && <Domains />}
            {current === 'settings' && <Settings />}
            {current === 'jobs' && <Jobs />}
            {current === 'audit' && <Audit />}
          </div>
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="bg-bg px-4 py-3">
      <div className="font-mono text-[10px] tracking-[0.16em] text-index uppercase">{label}</div>
      <div className={`mt-1 font-mono text-[18px] font-semibold ${tone ?? 'text-text'}`}>
        {value}
      </div>
    </div>
  );
}

function Overview() {
  const { data } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () =>
      api.get<{
        version: string;
        users: number;
        workspaces: number;
        issues: number;
        databaseSize: string | null;
        jobs: Record<string, number>;
        leases: { key: string; holder: string; expiresAt: string }[];
        realtimeConnections: number;
        storage: string;
        emailEnabled: boolean;
        secretKey: boolean;
      }>('/admin/overview'),
    refetchInterval: 10_000,
  });
  if (!data) return <Spinner />;
  return (
    <>
      <Card title={t('admin.overview.instance')}>
        <div className="grid grid-cols-2 gap-px bg-border-soft md:grid-cols-4">
          <Stat label={t('admin.overview.version')} value={data.version} />
          <Stat label={t('admin.overview.users')} value={data.users} />
          <Stat label={t('admin.overview.workspaces')} value={data.workspaces} />
          <Stat label={t('admin.overview.issues')} value={data.issues} />
          <Stat label={t('admin.overview.database')} value={data.databaseSize ?? '—'} />
          <Stat label={t('admin.overview.liveSockets')} value={data.realtimeConnections} />
          <Stat label={t('admin.overview.pendingJobs')} value={data.jobs.pending ?? 0} />
          <Stat
            label={t('admin.overview.deadJobs')}
            value={data.jobs.dead ?? 0}
            tone={data.jobs.dead ? 'text-error' : 'text-success'}
          />
        </div>
      </Card>
      <Card title={t('admin.overview.health')}>
        <div className="flex flex-col gap-2 font-mono text-[12.5px]">
          <span>
            <span
              className={`mr-2 inline-block h-[7px] w-[7px] ${data.emailEnabled ? 'bg-success' : 'bg-warning'}`}
            />
            {data.emailEnabled ? t('admin.overview.emailOk') : t('admin.overview.emailOff')}
          </span>
          <span>
            <span
              className={`mr-2 inline-block h-[7px] w-[7px] ${data.secretKey ? 'bg-success' : 'bg-error'}`}
            />
            {data.secretKey
              ? t('admin.overview.secretKeyOk')
              : t('admin.overview.secretKeyMissing')}
          </span>
          <span>
            <span className="mr-2 inline-block h-[7px] w-[7px] bg-success" />
            {t('admin.overview.storage', { storage: data.storage })}
          </span>
          {data.leases.map((l) => (
            <span key={l.key} className="text-muted">
              &gt; {t('admin.overview.lease', { key: l.key, holder: l.holder })}
            </span>
          ))}
        </div>
      </Card>
    </>
  );
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  username: string;
  kind: string;
  isInstanceAdmin: boolean;
  disabledAt: string | null;
  emailVerifiedAt: string | null;
  twoFactor: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  workspaceCount: number;
}

function Users({ myId }: { myId: string }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const { data = [] } = useQuery({
    queryKey: ['admin', 'users', q],
    queryFn: () => api.get<AdminUser[]>(`/admin/users?q=${encodeURIComponent(q)}`),
    placeholderData: (p) => p,
  });
  const reload = () => qc.invalidateQueries({ queryKey: ['admin', 'users'] });
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast.success(done);
      reload();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <Card title={t('admin.sections.users')}>
      <input
        className="input mb-4"
        placeholder={t('admin.users.search')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="overflow-x-auto">
        {data.map((u) => (
          <div
            key={u.id}
            className={`flex min-w-[640px] items-center gap-3 border-b border-border-soft py-2.5 ${u.disabledAt ? 'opacity-60' : ''}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13.5px]">
                {u.name}
                {u.isInstanceAdmin && (
                  <span className="chip [--chip:var(--color-primary)]">
                    {t('admin.users.admin')}
                  </span>
                )}
                {u.disabledAt && (
                  <span className="chip [--chip:var(--color-error)]">
                    {t('admin.users.disabled')}
                  </span>
                )}
                {u.kind !== 'human' && (
                  <span className="tag font-mono">
                    {known(u.kind, ['bot', 'placeholder'] as const, (k) =>
                      t(`admin.users.kind.${k}`),
                    )}
                  </span>
                )}
                {u.twoFactor && (
                  <Shield
                    size={12}
                    className="text-success"
                    aria-label={t('admin.users.twoFactorOn')}
                  />
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-index">
                {[
                  u.emailVerifiedAt ? u.email : t('admin.users.unverified', { email: u.email }),
                  t('admin.users.workspaces', { count: u.workspaceCount }),
                  t('admin.users.joined', { date: shortDate(u.createdAt) }),
                  u.lastSeenAt && t('admin.users.seen', { time: relativeTime(u.lastSeenAt) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            {u.id !== myId && u.kind === 'human' && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title={t('admin.users.resetLink')}
                  aria-label={t('admin.users.resetLinkFor', { name: u.name })}
                  onClick={() =>
                    act(async () => {
                      const res = await api.post<{ url: string; emailed: boolean }>(
                        `/admin/users/${u.id}/reset-link`,
                      );
                      navigator.clipboard?.writeText(res.url);
                      toast.success(
                        res.emailed ? t('admin.users.resetEmailed') : t('admin.users.resetCopied'),
                      );
                    })
                  }
                >
                  <KeyRound size={12} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    act(() =>
                      api.patch(`/admin/users/${u.id}`, { isInstanceAdmin: !u.isInstanceAdmin }),
                    )
                  }
                >
                  {u.isInstanceAdmin ? t('admin.users.revokeAdmin') : t('admin.users.makeAdmin')}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title={u.disabledAt ? t('admin.users.enable') : t('admin.users.disable')}
                  aria-label={
                    u.disabledAt
                      ? t('admin.users.enableUser', { name: u.name })
                      : t('admin.users.disableUser', { name: u.name })
                  }
                  onClick={() =>
                    act(() => api.patch(`/admin/users/${u.id}`, { disabled: !u.disabledAt }))
                  }
                >
                  {u.disabledAt ? <UserCheck size={12} /> : <Ban size={12} />}
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  aria-label={t('admin.users.deleteUser', { name: u.name })}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: t('admin.users.deleteTitle', { email: u.email }),
                      body: t('admin.users.deleteBody'),
                      danger: true,
                    });
                    if (ok) act(() => api.del(`/admin/users/${u.id}`), t('admin.users.deleted'));
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Workspaces() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({
    queryKey: ['admin', 'workspaces'],
    queryFn: () =>
      api.get<
        {
          id: string;
          name: string;
          slug: string;
          createdAt: string;
          members: number;
          issues: number;
          owners: string[];
        }[]
      >('/admin/workspaces'),
  });
  return (
    <Card title={t('admin.sections.workspaces')}>
      {data.map((w) => (
        <div key={w.id} className="flex items-center gap-3 border-b border-border-soft py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px]">
              {w.name} <span className="font-mono text-[11px] text-index">/{w.slug}</span>
            </div>
            <div className="truncate font-mono text-[11px] text-index">
              {[
                t('admin.workspaces.members', { count: w.members }),
                t('common.issueCount', { count: w.issues }),
                t('admin.workspaces.ownedBy', {
                  owners: w.owners.join(', ') || t('admin.workspaces.nobody'),
                }),
                t('admin.workspaces.created', { date: shortDate(w.createdAt) }),
              ].join(' · ')}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            aria-label={t('admin.workspaces.delete', { name: w.name })}
            onClick={async () => {
              const typed = prompt(
                t('admin.workspaces.deletePrompt', { name: w.name, slug: w.slug }),
              );
              if (typed !== w.slug) return;
              try {
                await api.del(`/admin/workspaces/${w.id}`, { confirmSlug: typed });
                qc.invalidateQueries({ queryKey: ['admin'] });
                toast.success(t('admin.workspaces.deleted'));
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </Card>
  );
}

function Domains() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({
    queryKey: ['admin', 'domains'],
    queryFn: () =>
      api.get<
        {
          id: string;
          domain: string;
          verified: boolean;
          verifiedBy: string | null;
          workspace: string;
          workspaceSlug: string;
        }[]
      >('/admin/domains'),
  });
  return (
    <Card title={t('admin.sections.domains')} description={t('admin.domains.description')}>
      {data.map((d) => (
        <div
          key={d.id}
          className="flex items-center gap-3 border-b border-border-soft py-2.5 text-[13px]"
        >
          <span className="flex-1 font-mono">{d.domain}</span>
          <span className="text-muted">{d.workspace}</span>
          {d.verified ? (
            <span className="chip [--chip:var(--color-success)]">
              {d.verifiedBy === 'instance_admin'
                ? t('admin.domains.verifiedByAdmin')
                : t('admin.domains.verified')}
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                try {
                  await api.post(`/admin/domains/${d.id}/approve`);
                  qc.invalidateQueries({ queryKey: ['admin', 'domains'] });
                } catch (err) {
                  toast.error(errMsg(err));
                }
              }}
            >
              {t('admin.domains.approve')}
            </button>
          )}
        </div>
      ))}
      {data.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('admin.domains.empty')}</p>
      )}
    </Card>
  );
}

function Settings() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<InstanceSettingEntry[]>('/admin/settings'),
  });
  const [smtpUrl, setSmtpUrl] = useState('');
  const [smtpFrom, setSmtpFrom] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  if (!data) return <Spinner />;
  const entry = <K extends InstanceSettingEntry['key']>(k: K) => data.find((e) => e.key === k)!;
  const locked = (k: InstanceSettingEntry['key']) => entry(k).source === 'env';
  const save = async (patch: object) => {
    try {
      await api.patch('/admin/settings', patch);
      qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      qc.invalidateQueries({ queryKey: ['config'] });
      toast.success(t('common.saved'));
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const smtp = entry('smtp').value as { url: string; from: string } | null;
  const lockedTag = (k: InstanceSettingEntry['key']) =>
    locked(k) ? <span className="tag ml-2 font-mono">{t('admin.settings.setByEnv')}</span> : null;

  const saveSmtp = (e: FormEvent) => {
    e.preventDefault();
    save({ smtp: { url: smtpUrl, from: smtpFrom ?? smtp?.from ?? '' } });
    setSmtpUrl('');
  };

  return (
    <>
      <Card title={t('admin.settings.signup')}>
        <label className="flex items-center justify-between border-b border-border-soft py-3 text-[13.5px]">
          <span>
            {t('admin.settings.signupMode')}
            {lockedTag('signupMode')}
          </span>
          <select
            className="input w-56"
            disabled={locked('signupMode')}
            value={entry('signupMode').value as string}
            onChange={(e) => save({ signupMode: e.target.value })}
          >
            <option value="invite">{t('admin.settings.inviteOnly')}</option>
            <option value="open">{t('admin.settings.anyone')}</option>
          </select>
        </label>
        <label className="flex items-center justify-between py-3 text-[13.5px]">
          <span>
            {t('admin.settings.allowWorkspaceCreation')}
            {lockedTag('allowWorkspaceCreation')}
          </span>
          <input
            type="checkbox"
            className="accent-primary"
            disabled={locked('allowWorkspaceCreation')}
            checked={entry('allowWorkspaceCreation').value as boolean}
            onChange={(e) => save({ allowWorkspaceCreation: e.target.checked })}
          />
        </label>
      </Card>

      <Card title={t('admin.settings.email')} description={t('admin.settings.emailDescription')}>
        {locked('smtp') ? (
          <p className="font-mono text-[12.5px] text-muted">
            {t('admin.settings.smtpFromEnv', { url: smtp?.url ?? '' })} {lockedTag('smtp')}
          </p>
        ) : (
          <form onSubmit={saveSmtp}>
            {smtp && (
              <p className="mb-3 font-mono text-[12px] text-muted">
                {t('admin.settings.current', { url: smtp.url })}
              </p>
            )}
            <div className="grid gap-2 md:grid-cols-[1fr_16rem_auto]">
              <input
                className="input"
                placeholder={
                  smtp
                    ? t('admin.settings.newSmtpUrl')
                    : 'smtps://user:password@smtp.example.com:465'
                }
                value={smtpUrl}
                onChange={(e) => setSmtpUrl(e.target.value)}
              />
              <input
                className="input"
                placeholder="Ordo <ordo@example.com>"
                value={smtpFrom ?? smtp?.from ?? ''}
                onChange={(e) => setSmtpFrom(e.target.value)}
                required
              />
              <button className="btn btn-primary">{t('common.save')}</button>
            </div>
            {smtp && (
              <button
                type="button"
                className="btn btn-danger btn-sm mt-3"
                onClick={() => save({ smtp: null })}
              >
                {t('admin.settings.turnEmailOff')}
              </button>
            )}
          </form>
        )}
        {smtp && (
          <form
            className="mt-5 flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.post('/admin/settings/test-email', { to: testTo });
                toast.success(t('admin.settings.testSent', { to: testTo }));
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            <input
              className="input w-72 max-w-full"
              type="email"
              placeholder="you@example.com"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              required
            />
            <button className="btn btn-ghost">{t('admin.settings.sendTest')}</button>
          </form>
        )}
      </Card>

      <Card title={t('admin.settings.network')}>
        <label className="flex items-center justify-between py-3 text-[13.5px]">
          <span>
            {t('admin.settings.allowPrivate')}
            {lockedTag('allowPrivateNetworkTargets')}
            <span className="block text-[12px] text-index">
              {t('admin.settings.allowPrivateHelp')}
            </span>
          </span>
          <input
            type="checkbox"
            className="accent-primary"
            disabled={locked('allowPrivateNetworkTargets')}
            checked={entry('allowPrivateNetworkTargets').value as boolean}
            onChange={(e) => save({ allowPrivateNetworkTargets: e.target.checked })}
          />
        </label>
      </Card>

      <Card title={t('admin.settings.uploads')}>
        <label className="flex items-center justify-between gap-4 py-3 text-[13.5px]">
          <span>
            {t('admin.settings.maxAttachment')}
            {lockedTag('maxAttachmentMb')}
            <span className="block text-[12px] text-index">
              {t('admin.settings.maxAttachmentHelp')}
            </span>
          </span>
          <input
            key={entry('maxAttachmentMb').value as number}
            className="input w-24 text-right font-mono"
            type="number"
            min={1}
            max={1024}
            disabled={locked('maxAttachmentMb')}
            defaultValue={entry('maxAttachmentMb').value as number}
            onBlur={(e) => {
              const mb = Number(e.target.value);
              if (Number.isInteger(mb) && mb >= 1 && mb !== entry('maxAttachmentMb').value)
                save({ maxAttachmentMb: mb });
            }}
          />
        </label>
      </Card>

      <AiCard
        // Starts over from what's saved after every save.
        key={JSON.stringify(entry('ai').value)}
        value={entry('ai').value as AiSettings | null}
        locked={locked('ai')}
        save={save}
      />
    </>
  );
}

const MODEL_HINTS: Record<AiSettings['provider'], { model: string; baseUrl: string }> = {
  anthropic: { model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com' },
  openai: { model: 'llama3.3', baseUrl: 'http://localhost:11434/v1' },
};

/**
 * The model behind AI assistance. Off by default: turning it on sends issue text to whatever is
 * chosen here whenever someone asks for a summary, a draft or suggestions.
 */
function AiCard({
  value,
  locked,
  save,
}: {
  value: AiSettings | null;
  locked: boolean;
  save: (patch: object) => Promise<void>;
}) {
  const [provider, setProvider] = useState<AiSettings['provider'] | 'off'>(
    value?.provider ?? 'off',
  );
  const [model, setModel] = useState(value?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(value?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const hint = provider === 'off' ? null : MODEL_HINTS[provider];
  const sameProvider = value?.provider === provider;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (provider === 'off') return save({ ai: null });
    await save({
      ai: {
        provider,
        model: model.trim() || hint!.model,
        baseUrl: baseUrl.trim() || (provider === 'openai' ? hint!.baseUrl : null),
        // Empty keeps the stored key, but only for the provider it was stored for.
        apiKey: apiKey.trim() || (sameProvider ? '' : null),
      },
    });
    setApiKey('');
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.post<{ reply: string; ms: number }>('/admin/settings/test-ai');
      const seconds = new Intl.NumberFormat(INTL_TAG[getLocale()], {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(r.ms / 1000);
      toast.success(t('admin.ai.answered', { seconds, reply: r.reply }));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card title={t('admin.ai.title')} description={t('admin.ai.description')}>
      {locked ? (
        <p className="font-mono text-[12.5px] text-muted">
          {t('admin.ai.fromEnv', {
            value: value
              ? `${value.provider} · ${value.model}${value.baseUrl ? ` · ${value.baseUrl}` : ''}`
              : t('admin.ai.off'),
          })}
          <span className="tag ml-2 font-mono">{t('admin.settings.setByEnv')}</span>
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label className="flex items-center justify-between gap-4 text-[13.5px]">
            {t('admin.ai.provider')}
            <select
              className="input w-72"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as typeof provider);
                setModel('');
                setBaseUrl('');
              }}
            >
              <option value="off">{t('admin.ai.providerOff')}</option>
              <option value="anthropic">{t('admin.ai.anthropic')}</option>
              <option value="openai">{t('admin.ai.openai')}</option>
            </select>
          </label>
          {hint && (
            <>
              {provider === 'anthropic' && (
                <p className="text-[12px] text-index">{t('admin.ai.anthropicNote')}</p>
              )}
              <label className="flex items-center justify-between gap-4 text-[13.5px]">
                {t('admin.ai.model')}
                <input
                  className="input w-72 font-mono"
                  placeholder={hint.model}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-[13.5px]">
                <span>
                  {t('admin.ai.baseUrl')}
                  <span className="block text-[12px] text-index">
                    {provider === 'openai'
                      ? t('admin.ai.baseUrlOpenai')
                      : t('admin.ai.baseUrlAnthropic')}
                  </span>
                </span>
                <input
                  className="input w-72 font-mono"
                  placeholder={hint.baseUrl}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-[13.5px]">
                <span>
                  {t('admin.ai.apiKey')}
                  <span className="block text-[12px] text-index">
                    {sameProvider && value?.apiKey
                      ? t('admin.ai.apiKeyCurrent', { key: value.apiKey })
                      : provider === 'openai'
                        ? t('admin.ai.apiKeyOptional')
                        : t('admin.ai.apiKeyConsole')}
                  </span>
                </span>
                <input
                  className="input w-72 font-mono"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
            </>
          )}
          <div className="flex gap-2 pt-1">
            <button className="btn btn-primary">{t('common.save')}</button>
            {value && (
              <button type="button" className="btn btn-ghost" onClick={test} disabled={testing}>
                {testing ? t('admin.ai.testing') : t('admin.ai.test')}
              </button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}

function Jobs() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({
    queryKey: ['admin', 'jobs'],
    queryFn: () =>
      api.get<
        {
          id: number;
          name: string;
          status: string;
          attempts: number;
          lastError: string | null;
          runAt: string;
          createdAt: string;
        }[]
      >('/admin/jobs'),
    refetchInterval: 10_000,
  });
  const reload = () => qc.invalidateQueries({ queryKey: ['admin', 'jobs'] });
  return (
    <Card title={t('admin.jobs.title')} description={t('admin.jobs.description')}>
      {data.map((j) => (
        <div key={j.id} className="border-b border-border-soft py-2.5">
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <span className="font-mono">{j.name}</span>
            <span
              className={`chip ${j.status === 'dead' ? '[--chip:var(--color-error)]' : '[--chip:var(--color-warning)]'}`}
            >
              {known(j.status, ['pending', 'running', 'dead'] as const, (k) =>
                t(`admin.jobs.status.${k}`),
              )}
            </span>
            <span className="font-mono text-[11px] text-index">
              {t('admin.jobs.attempts', { count: j.attempts })} ·{' '}
              {t(j.status === 'dead' ? 'admin.jobs.lastTried' : 'admin.jobs.next', {
                time: relativeTime(j.runAt),
              })}
            </span>
            {j.status === 'dead' && (
              <span className="ml-auto flex gap-1">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => api.post(`/admin/jobs/${j.id}/retry`).then(reload)}
                >
                  <RotateCcw size={12} /> {t('admin.jobs.retry')}
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  aria-label={t('admin.jobs.discard')}
                  onClick={() => api.del(`/admin/jobs/${j.id}`).then(reload)}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            )}
          </div>
          {j.lastError && (
            <pre className="mt-1 max-h-24 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-error">
              {j.lastError}
            </pre>
          )}
        </div>
      ))}
      {data.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('admin.jobs.empty')}</p>
      )}
    </Card>
  );
}

function Audit() {
  const [scope, setScope] = useState<'instance' | 'all'>('instance');
  const { data = [] } = useQuery({
    queryKey: ['admin', 'audit', scope],
    queryFn: () =>
      api.get<
        {
          id: string;
          actorEmail: string | null;
          action: string;
          data: Record<string, unknown>;
          ip: string | null;
          createdAt: string;
        }[]
      >(`/admin/audit-log?scope=${scope}`),
  });
  return (
    <Card title={t('admin.sections.audit')}>
      <div className="mb-3 flex flex-wrap gap-1">
        {(['instance', 'all'] as const).map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => setScope(s)}
            className={`h-6 px-2.5 font-mono text-[11px] tracking-[0.1em] uppercase ${scope === s ? 'bg-raised text-primary' : 'text-index hover:text-text'}`}
          >
            {s === 'instance' ? t('admin.audit.instance') : t('admin.audit.all')}
          </button>
        ))}
      </div>
      {data.map((e) => (
        <div
          key={e.id}
          className="flex items-start gap-3 border-b border-border-soft py-2 font-mono text-[12px]"
        >
          <span className="w-28 flex-none text-index">{relativeTime(e.createdAt)}</span>
          <span className="w-56 flex-none truncate">{e.actorEmail ?? '—'}</span>
          <span className="flex-1 text-primary">{e.action}</span>
          <span className="flex-none text-index">{e.ip}</span>
        </div>
      ))}
    </Card>
  );
}
