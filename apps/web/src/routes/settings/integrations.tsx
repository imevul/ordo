import type { Integration, IntegrationProviderInfo } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, GitPullRequest, Pencil, Plug, Power, Trash2, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import { relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './index.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

interface Field {
  key: string;
  label: string;
  secret?: boolean;
  multiline?: boolean;
  placeholder?: string;
  hint?: string;
  initial?: string;
}

/** What each forge needs when connecting with a token. */
const TOKEN_FORMS: Record<string, { fields: Field[]; docs: string }> = {
  github: {
    docs: 'A fine-grained token with read access to pull requests and contents, plus webhooks (read & write) to let Ordo add them.',
    fields: [
      { key: 'token', label: 'Personal access token', secret: true, placeholder: 'github_pat_…' },
      {
        key: 'repos',
        label: 'Repositories',
        multiline: true,
        placeholder: 'acme/app\nacme/api',
        hint: 'One owner/name per line.',
      },
      {
        key: 'apiUrl',
        label: 'API URL',
        initial: 'https://api.github.com',
        hint: 'Change only for GitHub Enterprise Server (https://host/api/v3).',
      },
      { key: 'webUrl', label: 'Web URL', initial: 'https://github.com' },
    ],
  },
  gitlab: {
    docs: 'A personal, group or project access token with the "api" scope (Maintainer, to add webhooks).',
    fields: [
      { key: 'baseUrl', label: 'GitLab URL', initial: 'https://gitlab.com' },
      { key: 'token', label: 'Access token', secret: true, placeholder: 'glpat-…' },
      {
        key: 'projects',
        label: 'Projects',
        multiline: true,
        placeholder: 'acme/app\nacme/platform/api',
        hint: 'One group/project path per line.',
      },
    ],
  },
  forgejo: {
    docs: 'An access token with read access to repositories and write access to their webhooks (repository admin).',
    fields: [
      { key: 'baseUrl', label: 'Server URL', placeholder: 'https://codeberg.org' },
      { key: 'token', label: 'Access token', secret: true },
      {
        key: 'repos',
        label: 'Repositories',
        multiline: true,
        placeholder: 'acme/app',
        hint: 'One owner/name per line.',
      },
    ],
  },
};

export function IntegrationsSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'integrations'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () =>
      api.get<{ providers: IntegrationProviderInfo[]; integrations: Integration[] }>(
        wsPath(ws.slug, '/integrations'),
      ),
    enabled: ws.isAdmin,
  });
  const [connecting, setConnecting] = useState<IntegrationProviderInfo | null>(null);
  const [editing, setEditing] = useState<Integration | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: key });

  useEffect(() => {
    // The GitHub App flow comes back with ?error= when something went wrong.
    const url = new URL(window.location.href);
    const error = url.searchParams.get('error');
    if (!error) return;
    toast.error(error);
    url.searchParams.delete('error');
    window.history.replaceState(null, '', url);
  }, []);

  if (!ws.isAdmin) return <p className="text-muted">Only admins can manage integrations.</p>;
  if (!data) return <Spinner />;
  const providerName = (k: string) => data.providers.find((p) => p.key === k)?.name ?? k;

  return (
    <>
      <SettingsCard title="Connected">
        {data.integrations.map((i) => (
          <div key={i.id} className="border-b border-border-soft py-3">
            <div className="flex items-center gap-3">
              <GitPullRequest
                size={14}
                className={`flex-none ${i.status === 'active' ? 'text-highlight' : 'text-index'}`}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px]">
                  {i.name}
                  <span className="ml-2 text-index">{providerName(i.provider)}</span>
                </div>
                <div className="truncate font-mono text-[11px] text-index">
                  {describe(i)}
                  {i.lastEventAt && ` · last event ${relativeTime(i.lastEventAt)}`}
                </div>
              </div>
              <StatusChip status={i.status} />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={`Settings for ${i.name}`}
                onClick={() => setEditing(i)}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={i.status === 'disabled' ? `Turn on ${i.name}` : `Turn off ${i.name}`}
                title={i.status === 'disabled' ? 'Turn on' : 'Turn off'}
                onClick={async () => {
                  await api.patch(wsPath(ws.slug, `/integrations/${i.id}`), {
                    enabled: i.status === 'disabled',
                  });
                  reload();
                }}
              >
                <Power size={12} />
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                aria-label={`Disconnect ${i.name}`}
                onClick={async () => {
                  if (
                    !(await confirmDialog({
                      title: `Disconnect ${i.name}?`,
                      body: 'Links already on issues stay.',
                      confirmLabel: 'Disconnect',
                      danger: true,
                    }))
                  )
                    return;
                  await api.del(wsPath(ws.slug, `/integrations/${i.id}`));
                  reload();
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
            {i.lastError && <p className="mt-2 text-[12px] text-error">{i.lastError}</p>}
          </div>
        ))}
        {data.integrations.length === 0 && (
          <p className="font-mono text-[12px] text-index">// nothing connected yet</p>
        )}
      </SettingsCard>

      <SettingsCard title="Add an integration">
        <div className="grid gap-3 sm:grid-cols-2">
          {data.providers.map((p) => (
            <div key={p.key} className="flex flex-col border border-border-soft bg-bg p-4">
              <div className="mb-1 font-semibold">{p.name}</div>
              <p className="mb-4 flex-1 text-[12.5px] text-muted">{p.description}</p>
              <button
                type="button"
                className="btn btn-ghost btn-sm self-start"
                onClick={() => setConnecting(p)}
              >
                <Plug size={12} /> Connect
              </button>
            </div>
          ))}
        </div>
      </SettingsCard>

      <ConnectModal
        provider={connecting}
        onClose={() => setConnecting(null)}
        onDone={() => {
          setConnecting(null);
          reload();
        }}
      />
      <EditModal
        integration={editing}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          reload();
        }}
      />
    </>
  );
}

function describe(i: Integration) {
  const c = i.config as {
    mode?: string;
    repos?: string[];
    projects?: string[];
    delivery?: string;
    baseUrl?: string;
  };
  if (c.mode === 'app') return 'GitHub App installation';
  const list = c.repos ?? c.projects ?? [];
  const where =
    list.length > 2 ? `${list.slice(0, 2).join(', ')} +${list.length - 2}` : list.join(', ');
  return `${where} · ${c.delivery === 'poll' ? 'polling' : 'webhooks'}`;
}

function StatusChip({ status }: { status: Integration['status'] }) {
  if (status === 'active')
    return <span className="chip [--chip:var(--color-success)]">active</span>;
  if (status === 'error') return <span className="chip [--chip:var(--color-error)]">error</span>;
  return <span className="tag font-mono">off</span>;
}

/** Webhooks or polling, and whether to comment on pull requests. Shared by connect and edit. */
function DeliveryFields({
  delivery,
  setDelivery,
  comment,
  setComment,
  providerName,
}: {
  delivery: string;
  setDelivery: (v: string) => void;
  comment: boolean;
  setComment: (v: boolean) => void;
  providerName: string;
}) {
  const local = /localhost|127\.0\.0\.1|\.local\b|\.lan\b/.test(location.host);
  return (
    <>
      <div className="mb-1 text-[12px] text-muted">How Ordo hears about changes</div>
      <label className="mb-1 flex items-start gap-2 text-[13px]">
        <input
          type="radio"
          className="mt-1 accent-[#ff1493]"
          checked={delivery === 'webhook'}
          onChange={() => setDelivery('webhook')}
        />
        <span>
          Webhooks (instant)
          <span className="block text-[11.5px] text-index">
            {providerName} must be able to reach {location.origin}.
          </span>
        </span>
      </label>
      <label className="mb-4 flex items-start gap-2 text-[13px]">
        <input
          type="radio"
          className="mt-1 accent-[#ff1493]"
          checked={delivery === 'poll'}
          onChange={() => setDelivery('poll')}
        />
        <span>
          Polling (every two minutes)
          <span className="block text-[11.5px] text-index">
            For instances {providerName} can't reach{local ? ' — like this one looks to be' : ''}.
          </span>
        </span>
      </label>
      <label className="mb-2 flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          className="accent-[#ff1493]"
          checked={comment}
          onChange={(e) => setComment(e.target.checked)}
        />
        Comment on pull requests with a link to the issue
      </label>
    </>
  );
}

function TokenForm({
  provider,
  existing,
  onDone,
  onCancel,
}: {
  provider: IntegrationProviderInfo;
  existing?: Integration;
  onDone: () => void;
  onCancel: () => void;
}) {
  const ws = useWorkspace();
  const form = TOKEN_FORMS[provider.key]!;
  const config = (existing?.config ?? {}) as Record<string, unknown>;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      form.fields.map((f) => {
        const current = config[f.key];
        return [
          f.key,
          f.secret
            ? ''
            : Array.isArray(current)
              ? current.join('\n')
              : String(current ?? f.initial ?? ''),
        ];
      }),
    ),
  );
  const [delivery, setDelivery] = useState(String(config.delivery ?? 'webhook'));
  const [comment, setComment] = useState(config.commentOnPullRequests === true);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const cfg: Record<string, unknown> = { delivery, commentOnPullRequests: comment };
    const secrets: Record<string, string> = {};
    for (const f of form.fields) (f.secret ? secrets : cfg)[f.key] = values[f.key]!;
    try {
      const res = existing
        ? await api.patch<Integration>(wsPath(ws.slug, `/integrations/${existing.id}`), {
            config: cfg,
            secrets,
          })
        : await api.post<Integration>(wsPath(ws.slug, '/integrations'), {
            provider: provider.key,
            config: cfg,
            secrets,
          });
      if (res.status === 'error') toast.error(`Saved, but: ${res.lastError}`);
      else toast.success(existing ? 'Saved' : `${provider.name} connected`);
      onDone();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <p className="mb-4 text-[12.5px] text-muted">{form.docs}</p>
      {form.fields.map((f) => (
        <FormRow
          key={f.key}
          label={f.label}
          hint={f.secret && existing ? 'Leave empty to keep the current one.' : f.hint}
        >
          {f.multiline ? (
            <textarea
              className="input min-h-20 font-mono"
              required
              placeholder={f.placeholder}
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          ) : (
            <input
              className="input font-mono"
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              required={!(f.secret && existing) && !f.initial}
              placeholder={f.placeholder}
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          )}
        </FormRow>
      ))}
      <DeliveryFields
        delivery={delivery}
        setDelivery={setDelivery}
        comment={comment}
        setComment={setComment}
        providerName={provider.name}
      />
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {existing ? 'Save' : 'Connect'}
        </button>
      </div>
    </form>
  );
}

function GithubAppPanel({ onCancel }: { onCancel: () => void }) {
  const ws = useWorkspace();
  const { data } = useQuery({
    queryKey: ['ws', ws.slug, 'github-app'],
    queryFn: () =>
      api.get<{
        app: { name: string; htmlUrl: string } | null;
        canCreate: boolean;
        publicUrl: string;
      }>(wsPath(ws.slug, '/integrations/github/app')),
  });
  const [org, setOrg] = useState('');
  if (!data) return <Spinner />;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { action, manifest } = await api.post<{ action: string; manifest: string }>(
        wsPath(ws.slug, '/integrations/github/manifest'),
        { org: org.trim() || undefined },
      );
      // GitHub takes the manifest as a form POST.
      const form = document.createElement('form');
      form.method = 'post';
      form.action = action;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'manifest';
      input.value = manifest;
      form.append(input);
      document.body.append(form);
      form.submit();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const install = async () => {
    try {
      const { url } = await api.post<{ url: string }>(
        wsPath(ws.slug, '/integrations/github/install'),
      );
      window.location.assign(url);
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <div>
      <p className="mb-4 text-[12.5px] text-muted">
        The GitHub App is the smoothest way: install it on your account or organisation, pick the
        repositories, done. GitHub needs to reach{' '}
        <span className="font-mono">{data.publicUrl}</span>.
      </p>
      {data.app ? (
        <button type="button" className="btn btn-primary" onClick={install}>
          Install {data.app.name} on GitHub <span className="arrow">→</span>
        </button>
      ) : data.canCreate ? (
        <form onSubmit={create}>
          <FormRow
            label="GitHub organisation (optional)"
            hint="Owns the app. Leave empty to create it under your personal account. The app is private: it can only be installed where it's owned."
          >
            <input
              className="input"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="acme"
            />
          </FormRow>
          <button className="btn btn-primary">
            Create the GitHub App <span className="arrow">→</span>
          </button>
        </form>
      ) : (
        <p className="text-[13px] text-muted">
          An instance admin has to create the GitHub App once. Until then, connect with a token.
        </p>
      )}
      <div className="mt-6 flex justify-end">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ConnectModal({
  provider,
  onClose,
  onDone,
}: {
  provider: IntegrationProviderInfo | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<'app' | 'token'>('app');
  // biome-ignore lint/correctness/useExhaustiveDependencies: start each provider on its first tab
  useEffect(() => setTab('app'), [provider]);
  if (!provider) return null;
  const isGithub = provider.key === 'github';
  return (
    <Modal open onClose={onClose} width={560} label={`Connect ${provider.name}`} align="center">
      <div className="max-h-[82vh] overflow-y-auto p-6">
        <div className="section-label mb-4">Connect {provider.name}</div>
        {isGithub && (
          <div className="mb-5 flex gap-1 border-b border-border-soft">
            {(['app', 'token'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`-mb-px border-b-2 px-3 py-1.5 font-mono text-[11px] tracking-[0.12em] uppercase ${tab === t ? 'border-primary text-text' : 'border-transparent text-index hover:text-text'}`}
                onClick={() => setTab(t)}
              >
                {t === 'app' ? 'GitHub App' : 'Access token'}
              </button>
            ))}
          </div>
        )}
        {isGithub && tab === 'app' ? (
          <GithubAppPanel onCancel={onClose} />
        ) : TOKEN_FORMS[provider.key] ? (
          <TokenForm provider={provider} onDone={onDone} onCancel={onClose} />
        ) : (
          <p className="text-muted">This integration is set up elsewhere.</p>
        )}
      </div>
    </Modal>
  );
}

function EditModal({
  integration,
  onClose,
  onDone,
}: {
  integration: Integration | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const ws = useWorkspace();
  const [comment, setComment] = useState(false);
  useEffect(() => {
    setComment(
      (integration?.config as { commentOnPullRequests?: boolean })?.commentOnPullRequests === true,
    );
  }, [integration]);
  if (!integration) return null;
  const app = (integration.config as { mode?: string }).mode === 'app';
  const info: IntegrationProviderInfo = {
    key: integration.provider,
    name: integration.name,
    description: '',
    category: 'forge',
  };
  return (
    <Modal open onClose={onClose} width={560} label={`${integration.name} settings`} align="center">
      <div className="max-h-[82vh] overflow-y-auto p-6">
        <div className="section-label mb-4">{integration.name}</div>
        {integration.inboundUrl && (
          <div className="mb-5 border border-border-soft bg-bg p-3">
            <div className="mb-1 font-mono text-[10.5px] tracking-[0.16em] text-index uppercase">
              Webhook URL
            </div>
            <code className="block truncate font-mono text-[12px]">{integration.inboundUrl}</code>
          </div>
        )}
        {app ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await api.patch(wsPath(ws.slug, `/integrations/${integration.id}`), {
                config: { commentOnPullRequests: comment },
              });
              onDone();
            }}
          >
            <p className="mb-4 text-[12.5px] text-muted">
              Choose repositories on GitHub, in the app's installation settings.
            </p>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="accent-[#ff1493]"
                checked={comment}
                onChange={(e) => setComment(e.target.checked)}
              />
              Comment on pull requests with a link to the issue
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary">Save</button>
            </div>
          </form>
        ) : (
          <TokenForm provider={info} existing={integration} onDone={onDone} onCancel={onClose} />
        )}
      </div>
    </Modal>
  );
}

// ─── Account → Git usernames ─────────────────────────────────────────────

interface Claims {
  services: { provider: string; name: string; host: string }[];
  accounts: { id: string; provider: string; host: string; username: string }[];
}

/** People claim their forge usernames so pull requests they open are credited to them. */
export function GitAccountsCard() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'external-accounts'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Claims>(wsPath(ws.slug, '/me/external-accounts')),
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (!data?.services.length) return null;
  const reload = () => qc.invalidateQueries({ queryKey: key });
  return (
    <SettingsCard
      title="Git usernames"
      description={`Your usernames on the forges ${ws.workspace.name} is connected to, so your pull requests show as yours.`}
    >
      {data.services.map((s) => {
        const id = `${s.provider}:${s.host}`;
        const mine = data.accounts.filter((a) => a.provider === s.provider && a.host === s.host);
        return (
          <div key={id} className="border-b border-border-soft py-3">
            <div className="mb-2 text-[13px]">
              {s.name} <span className="font-mono text-[11.5px] text-index">{s.host}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {mine.map((a) => (
                <span key={a.id} className="tag inline-flex items-center gap-1 font-mono">
                  <AtSign size={11} />
                  {a.username}
                  <button
                    type="button"
                    aria-label={`Remove ${a.username}`}
                    className="text-index hover:text-text"
                    onClick={async () => {
                      await api.del(wsPath(ws.slug, `/me/external-accounts/${a.id}`));
                      reload();
                    }}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              <form
                className="flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await api.post(wsPath(ws.slug, '/me/external-accounts'), {
                      provider: s.provider,
                      host: s.host,
                      username: drafts[id] ?? '',
                    });
                    setDrafts({ ...drafts, [id]: '' });
                    reload();
                  } catch (err) {
                    toast.error(errMsg(err));
                  }
                }}
              >
                <input
                  className="input h-7 w-44 font-mono text-[12px]"
                  placeholder="username"
                  value={drafts[id] ?? ''}
                  onChange={(e) => setDrafts({ ...drafts, [id]: e.target.value })}
                  aria-label={`Your ${s.name} username`}
                />
                <button className="btn btn-ghost btn-sm">Add</button>
              </form>
            </div>
          </div>
        );
      })}
    </SettingsCard>
  );
}
