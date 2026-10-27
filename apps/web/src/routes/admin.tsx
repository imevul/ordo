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
import { relativeTime, shortDate } from '../lib/format.ts';

/**
 * The instance administrator's area: every user and workspace on this Ordo, instance settings,
 * background jobs and health. Lives outside any workspace.
 */

const SECTIONS = [
  { key: 'overview', label: 'Overview' },
  { key: 'users', label: 'Users' },
  { key: 'workspaces', label: 'Workspaces' },
  { key: 'domains', label: 'Domains' },
  { key: 'settings', label: 'Settings' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'audit', label: 'Audit log' },
] as const;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

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
  if (me.isLoading) return <Spinner label="booting" />;
  if (!me.data) return <Navigate to="/login" search={{ redirect: `/admin/${section}` }} />;
  if (!me.data.isInstanceAdmin) return <Navigate to="/" />;
  const current = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0];
  const back = me.data.workspaces[0];

  return (
    <div className="flex h-full">
      <nav
        className="hidden w-56 flex-none flex-col border-r border-border-soft bg-surface p-3 md:flex"
        aria-label="Admin"
      >
        <div className="mb-6 flex h-9 items-center px-2">
          <OrdoMark />
          <span className="ml-2 font-mono text-[10.5px] tracking-[0.16em] text-primary uppercase">
            admin
          </span>
        </div>
        {SECTIONS.map((s) => (
          <Link
            key={s.key}
            to="/admin/$section"
            params={{ section: s.key }}
            className={`nav-item ${s.key === current.key ? 'active' : ''}`}
          >
            {s.label}
          </Link>
        ))}
        {back && (
          <Link to="/$slug" params={{ slug: back.slug }} className="nav-item mt-auto">
            <ArrowLeft size={14} /> Back to {back.name}
          </Link>
        )}
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          kicker={
            <>
              instance
              <Sep />
              {current.key}
            </>
          }
          title={current.label}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-6 py-8">
            {current.key === 'overview' && <Overview />}
            {current.key === 'users' && <Users myId={me.data.id} />}
            {current.key === 'workspaces' && <Workspaces />}
            {current.key === 'domains' && <Domains />}
            {current.key === 'settings' && <Settings />}
            {current.key === 'jobs' && <Jobs />}
            {current.key === 'audit' && <Audit />}
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
      <Card title="Instance">
        <div className="grid grid-cols-2 gap-px bg-border-soft md:grid-cols-4">
          <Stat label="version" value={data.version} />
          <Stat label="users" value={data.users} />
          <Stat label="workspaces" value={data.workspaces} />
          <Stat label="issues" value={data.issues} />
          <Stat label="database" value={data.databaseSize ?? '—'} />
          <Stat label="live sockets" value={data.realtimeConnections} />
          <Stat label="pending jobs" value={data.jobs.pending ?? 0} />
          <Stat
            label="dead jobs"
            value={data.jobs.dead ?? 0}
            tone={data.jobs.dead ? 'text-error' : 'text-success'}
          />
        </div>
      </Card>
      <Card title="Health">
        <div className="flex flex-col gap-2 font-mono text-[12.5px]">
          <span>
            <span
              className={`mr-2 inline-block h-[7px] w-[7px] ${data.emailEnabled ? 'bg-success' : 'bg-warning'}`}
            />
            email{' '}
            {data.emailEnabled
              ? 'configured'
              : 'not configured — password resets and emailed invites are off'}
          </span>
          <span>
            <span
              className={`mr-2 inline-block h-[7px] w-[7px] ${data.secretKey ? 'bg-success' : 'bg-error'}`}
            />
            secret key {data.secretKey ? 'present' : 'missing — set ORDO_SECRET_KEY'}
          </span>
          <span>
            <span className="mr-2 inline-block h-[7px] w-[7px] bg-success" />
            storage: {data.storage}
          </span>
          {data.leases.map((l) => (
            <span key={l.key} className="text-muted">
              &gt; lease {l.key} held by {l.holder}
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
    <Card title="Users">
      <input
        className="input mb-4"
        placeholder="Search by name, email or username…"
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
                  <span className="chip [--chip:var(--color-primary)]">admin</span>
                )}
                {u.disabledAt && <span className="chip [--chip:var(--color-error)]">disabled</span>}
                {u.kind !== 'human' && <span className="tag font-mono">{u.kind}</span>}
                {u.twoFactor && <Shield size={12} className="text-success" aria-label="2FA on" />}
              </div>
              <div className="truncate font-mono text-[11px] text-index">
                {u.email}
                {!u.emailVerifiedAt && ' (unverified)'} · {u.workspaceCount} workspace
                {u.workspaceCount === 1 ? '' : 's'} · joined {shortDate(u.createdAt)}
                {u.lastSeenAt && ` · seen ${relativeTime(u.lastSeenAt)}`}
              </div>
            </div>
            {u.id !== myId && u.kind === 'human' && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title="Password reset link"
                  aria-label={`Reset link for ${u.name}`}
                  onClick={() =>
                    act(async () => {
                      const res = await api.post<{ url: string; emailed: boolean }>(
                        `/admin/users/${u.id}/reset-link`,
                      );
                      navigator.clipboard?.writeText(res.url);
                      toast.success(
                        res.emailed
                          ? 'Reset link emailed and copied'
                          : 'Reset link copied — send it to them',
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
                  {u.isInstanceAdmin ? 'Revoke admin' : 'Make admin'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title={u.disabledAt ? 'Enable' : 'Disable (signs them out)'}
                  aria-label={u.disabledAt ? `Enable ${u.name}` : `Disable ${u.name}`}
                  onClick={() =>
                    act(() => api.patch(`/admin/users/${u.id}`, { disabled: !u.disabledAt }))
                  }
                >
                  {u.disabledAt ? <UserCheck size={12} /> : <Ban size={12} />}
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  aria-label={`Delete ${u.name}`}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: `Delete ${u.email}?`,
                      body: 'Their issues and comments stay, attributed to a former member.',
                      danger: true,
                    });
                    if (ok) act(() => api.del(`/admin/users/${u.id}`), 'User deleted');
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
    <Card title="Workspaces">
      {data.map((w) => (
        <div key={w.id} className="flex items-center gap-3 border-b border-border-soft py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px]">
              {w.name} <span className="font-mono text-[11px] text-index">/{w.slug}</span>
            </div>
            <div className="truncate font-mono text-[11px] text-index">
              {w.members} members · {w.issues} issues · owned by {w.owners.join(', ') || 'nobody'} ·
              created {shortDate(w.createdAt)}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            aria-label={`Delete ${w.name}`}
            onClick={async () => {
              const typed = prompt(
                `This deletes ${w.name} and everything in it. Type its URL (${w.slug}) to confirm.`,
              );
              if (typed !== w.slug) return;
              try {
                await api.del(`/admin/workspaces/${w.id}`, { confirmSlug: typed });
                qc.invalidateQueries({ queryKey: ['admin'] });
                toast.success('Workspace deleted');
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
    <Card
      title="Domains"
      description="Domains workspaces have claimed. Approve one when DNS verification isn't possible (internal domains); a domain can belong to one workspace only."
    >
      {data.map((d) => (
        <div
          key={d.id}
          className="flex items-center gap-3 border-b border-border-soft py-2.5 text-[13px]"
        >
          <span className="flex-1 font-mono">{d.domain}</span>
          <span className="text-muted">{d.workspace}</span>
          {d.verified ? (
            <span className="chip [--chip:var(--color-success)]">
              verified{d.verifiedBy === 'instance_admin' ? ' by admin' : ''}
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
              Approve
            </button>
          )}
        </div>
      ))}
      {data.length === 0 && (
        <p className="font-mono text-[12px] text-index">// no domains claimed</p>
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
      toast.success('Saved');
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const smtp = entry('smtp').value as { url: string; from: string } | null;
  const lockedTag = (k: InstanceSettingEntry['key']) =>
    locked(k) ? <span className="tag ml-2 font-mono">set by env</span> : null;

  const saveSmtp = (e: FormEvent) => {
    e.preventDefault();
    save({ smtp: { url: smtpUrl, from: smtpFrom ?? smtp?.from ?? '' } });
    setSmtpUrl('');
  };

  return (
    <>
      <Card title="Sign-up">
        <label className="flex items-center justify-between border-b border-border-soft py-3 text-[13.5px]">
          <span>
            Who can create an account
            {lockedTag('signupMode')}
          </span>
          <select
            className="input w-56"
            disabled={locked('signupMode')}
            value={entry('signupMode').value as string}
            onChange={(e) => save({ signupMode: e.target.value })}
          >
            <option value="invite">Only people with an invite</option>
            <option value="open">Anyone</option>
          </select>
        </label>
        <label className="flex items-center justify-between py-3 text-[13.5px]">
          <span>
            Members may create more workspaces
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

      <Card
        title="Email"
        description="Used for password resets, invites, email verification and notification emails. The password is stored encrypted and never shown again."
      >
        {locked('smtp') ? (
          <p className="font-mono text-[12.5px] text-muted">
            Set by ORDO_SMTP_URL: {smtp?.url} {lockedTag('smtp')}
          </p>
        ) : (
          <form onSubmit={saveSmtp}>
            {smtp && <p className="mb-3 font-mono text-[12px] text-muted">Current: {smtp.url}</p>}
            <div className="grid gap-2 md:grid-cols-[1fr_16rem_auto]">
              <input
                className="input"
                placeholder={
                  smtp
                    ? 'New SMTP URL (leave empty to keep)'
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
              <button className="btn btn-primary">Save</button>
            </div>
            {smtp && (
              <button
                type="button"
                className="btn btn-danger btn-sm mt-3"
                onClick={() => save({ smtp: null })}
              >
                Turn email off
              </button>
            )}
          </form>
        )}
        {smtp && (
          <form
            className="mt-5 flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.post('/admin/settings/test-email', { to: testTo });
                toast.success(`Test email sent to ${testTo}`);
              } catch (err) {
                toast.error(errMsg(err));
              }
            }}
          >
            <input
              className="input w-72"
              type="email"
              placeholder="you@example.com"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              required
            />
            <button className="btn btn-ghost">Send test email</button>
          </form>
        )}
      </Card>

      <Card title="Network">
        <label className="flex items-center justify-between py-3 text-[13.5px]">
          <span>
            Allow private network targets
            {lockedTag('allowPrivateNetworkTargets')}
            <span className="block text-[12px] text-index">
              Let SSO discovery, webhooks and integrations reach LAN or loopback addresses (e.g. a
              self-hosted Keycloak on 10.0.0.5). Off protects against server-side request forgery.
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

      <Card title="Uploads">
        <label className="flex items-center justify-between gap-4 py-3 text-[13.5px]">
          <span>
            Largest attachment
            {lockedTag('maxAttachmentMb')}
            <span className="block text-[12px] text-index">
              Files people attach to issues and comments, in megabytes. Keep your reverse proxy's
              body limit above this.
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
      toast.success(`The model answered in ${(r.ms / 1000).toFixed(1)} s: “${r.reply}”`);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      title="AI assistance"
      description="Issue summaries, drafts written from rough notes, and triage suggestions (priority, labels, duplicates). When someone asks, the issue text they can see is sent to this model; nothing is changed until they apply a suggestion. Workspace admins can turn it off for their workspace."
    >
      {locked ? (
        <p className="font-mono text-[12.5px] text-muted">
          Set by ORDO_AI_PROVIDER:{' '}
          {value
            ? `${value.provider} · ${value.model}${value.baseUrl ? ` · ${value.baseUrl}` : ''}`
            : 'off'}
          <span className="tag ml-2 font-mono">set by env</span>
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label className="flex items-center justify-between gap-4 text-[13.5px]">
            Provider
            <select
              className="input w-72"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as typeof provider);
                setModel('');
                setBaseUrl('');
              }}
            >
              <option value="off">Off</option>
              <option value="anthropic">Claude API (Anthropic)</option>
              <option value="openai">OpenAI-compatible (Ollama, vLLM, LM Studio…)</option>
            </select>
          </label>
          {hint && (
            <>
              {provider === 'anthropic' && (
                <p className="text-[12px] text-index">
                  Issue text leaves this server for Anthropic's API, under your API account's terms.
                  Pick a local model instead to keep everything on your own hardware.
                </p>
              )}
              <label className="flex items-center justify-between gap-4 text-[13.5px]">
                Model
                <input
                  className="input w-72 font-mono"
                  placeholder={hint.model}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-[13.5px]">
                <span>
                  Base URL
                  <span className="block text-[12px] text-index">
                    {provider === 'openai'
                      ? 'Ends in /v1. Private and local addresses are allowed here.'
                      : 'Only for a gateway or proxy in front of the API.'}
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
                  API key
                  <span className="block text-[12px] text-index">
                    {sameProvider && value?.apiKey
                      ? `Current: ${value.apiKey}. Leave empty to keep it.`
                      : provider === 'openai'
                        ? 'Optional; local servers usually need none.'
                        : 'From the Claude Console. Stored encrypted.'}
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
            <button className="btn btn-primary">Save</button>
            {value && (
              <button type="button" className="btn btn-ghost" onClick={test} disabled={testing}>
                {testing ? 'Testing…' : 'Test connection'}
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
    <Card
      title="Background jobs"
      description="Queued and failed jobs. Failed jobs retry with backoff, then stop here as dead."
    >
      {data.map((j) => (
        <div key={j.id} className="border-b border-border-soft py-2.5">
          <div className="flex items-center gap-3 text-[13px]">
            <span className="font-mono">{j.name}</span>
            <span
              className={`chip ${j.status === 'dead' ? '[--chip:var(--color-error)]' : '[--chip:var(--color-warning)]'}`}
            >
              {j.status}
            </span>
            <span className="font-mono text-[11px] text-index">
              {j.attempts} attempt{j.attempts === 1 ? '' : 's'} · next {relativeTime(j.runAt)}
            </span>
            {j.status === 'dead' && (
              <span className="ml-auto flex gap-1">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => api.post(`/admin/jobs/${j.id}/retry`).then(reload)}
                >
                  <RotateCcw size={12} /> Retry
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  aria-label="Discard"
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
      {data.length === 0 && <p className="font-mono text-[12px] text-index">// queue is empty</p>}
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
    <Card title="Audit log">
      <div className="mb-3 flex gap-1">
        {(['instance', 'all'] as const).map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => setScope(s)}
            className={`h-6 px-2.5 font-mono text-[11px] tracking-[0.1em] uppercase ${scope === s ? 'bg-raised text-primary' : 'text-index hover:text-text'}`}
          >
            {s === 'instance' ? 'sign-ins & instance' : 'everything'}
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
