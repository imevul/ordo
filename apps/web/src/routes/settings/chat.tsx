import {
  CHAT_EVENT_KINDS,
  type ChatChannel,
  type ChatEventKind,
  type ChatService,
  type Integration,
  type IntegrationProviderInfo,
} from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, BellRing, Copy, Link2, Plus, Trash2, Unlink } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { confirmDialog } from '../../components/ui/Modal.tsx';
import { t, tx } from '../../i18n/index.ts';
import { relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

interface Field {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
  /** Only for these delivery modes. */
  for?: string[];
}

interface ChatForm {
  docs: string;
  /** What a channel id looks like here. */
  channelHint: string;
  deliveries: { key: string; label: string; hint: string }[];
  fields: Field[];
}

/**
 * What each chat service needs. See docs/integrations for the matching app setup. A function:
 * labels follow the language.
 */
export const chatForms = (): Record<string, ChatForm> => ({
  slack: {
    docs: t('integrations.chat.slack.docs'),
    channelHint: t('integrations.chat.slack.channelHint'),
    deliveries: [
      {
        key: 'events',
        label: t('integrations.chat.slack.events'),
        hint: t('integrations.chat.slack.eventsHint'),
      },
      {
        key: 'socket',
        label: t('integrations.chat.slack.socket'),
        hint: t('integrations.chat.slack.socketHint'),
      },
    ],
    fields: [
      {
        key: 'botToken',
        label: t('integrations.chat.botToken'),
        secret: true,
        placeholder: 'xoxb-…',
      },
      {
        key: 'signingSecret',
        label: t('integrations.chat.slack.signingSecret'),
        secret: true,
        for: ['events'],
      },
      {
        key: 'appToken',
        label: t('integrations.chat.slack.appToken'),
        secret: true,
        placeholder: 'xapp-…',
        hint: t('integrations.chat.slack.appTokenHint'),
        for: ['socket'],
      },
    ],
  },
  discord: {
    docs: t('integrations.chat.discord.docs'),
    channelHint: t('integrations.chat.discord.channelHint'),
    deliveries: [
      {
        key: 'interactions',
        label: t('integrations.chat.discord.interactions'),
        hint: t('integrations.chat.discord.interactionsHint'),
      },
      {
        key: 'gateway',
        label: t('integrations.chat.discord.gateway'),
        hint: t('integrations.chat.discord.gatewayHint'),
      },
    ],
    fields: [
      {
        key: 'applicationId',
        label: t('integrations.chat.discord.applicationId'),
        placeholder: '1234567890',
      },
      { key: 'botToken', label: t('integrations.chat.botToken'), secret: true },
      {
        key: 'publicKey',
        label: t('integrations.chat.discord.publicKey'),
        secret: true,
        hint: t('integrations.chat.discord.publicKeyHint'),
        for: ['interactions'],
      },
    ],
  },
  matrix: {
    docs: t('integrations.chat.matrix.docs'),
    channelHint: t('integrations.chat.matrix.channelHint'),
    deliveries: [],
    fields: [
      {
        key: 'homeserverUrl',
        label: t('integrations.chat.matrix.homeserverUrl'),
        placeholder: 'https://matrix.example.org',
      },
      { key: 'accessToken', label: t('integrations.chat.accessToken'), secret: true },
    ],
  },
  telegram: {
    docs: t('integrations.chat.telegram.docs'),
    channelHint: t('integrations.chat.telegram.channelHint'),
    deliveries: [
      {
        key: 'webhook',
        label: t('integrations.chat.telegram.webhook'),
        hint: t('integrations.chat.telegram.webhookHint'),
      },
      {
        key: 'longpoll',
        label: t('integrations.chat.telegram.longpoll'),
        hint: t('integrations.chat.telegram.longpollHint'),
      },
    ],
    fields: [
      {
        key: 'botToken',
        label: t('integrations.chat.botToken'),
        secret: true,
        placeholder: '123456:ABC…',
      },
    ],
  },
});

function eventLabel(kind: ChatEventKind) {
  switch (kind) {
    case 'issue.created':
      return t('integrations.chat.events.issueCreated');
    case 'issue.status':
      return t('integrations.chat.events.issueStatus');
    case 'issue.completed':
      return t('integrations.chat.events.issueCompleted');
    case 'comment.created':
      return t('integrations.chat.events.commentCreated');
    case 'project_update.created':
      return t('integrations.chat.events.projectUpdateCreated');
  }
}

const emptyChannel = (): ChatChannel => ({
  id: '',
  name: '',
  teamIds: [],
  events: ['issue.created', 'issue.completed'],
  defaultTeamId: null,
});

/** Channels and what each one hears about. */
function ChannelsEditor({
  value,
  onChange,
  hint,
}: {
  value: ChatChannel[];
  onChange: (v: ChatChannel[]) => void;
  hint: string;
}) {
  const ws = useWorkspace();
  const teams = [...ws.teamById.values()];
  const set = (i: number, patch: Partial<ChatChannel>) =>
    onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const toggle = <T,>(list: T[], item: T) =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
  return (
    <div className="mb-4">
      <div className="mb-1 text-[12px] text-muted">{t('integrations.chat.channels')}</div>
      <p className="mb-2 text-[11.5px] text-index">{hint}</p>
      {value.map((c, i) => (
        <div key={i} className="mb-2 border border-border-soft bg-bg p-3">
          <div className="mb-2 flex gap-2">
            <input
              className="input flex-1 font-mono"
              placeholder={t('integrations.chat.channelId')}
              aria-label={t('integrations.chat.channelId')}
              required
              value={c.id}
              onChange={(e) => set(i, { id: e.target.value })}
            />
            <input
              className="input w-36"
              placeholder={t('integrations.chat.channelNamePlaceholder')}
              aria-label={t('integrations.chat.channelName')}
              value={c.name ?? ''}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t('integrations.chat.removeChannel')}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
            {CHAT_EVENT_KINDS.map((k) => (
              <label key={k} className="flex items-center gap-1.5 text-[12.5px]">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={c.events.includes(k)}
                  onChange={() => set(i, { events: toggle(c.events, k) })}
                />
                {eventLabel(k)}
              </label>
            ))}
          </div>
          <div className="mb-1 text-[11.5px] text-index">
            {c.teamIds.length
              ? t('integrations.chat.fromTeams')
              : t('integrations.chat.fromPublicTeams')}
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {teams.map((team) => (
              <button
                key={team.id}
                type="button"
                className={`tag font-mono ${c.teamIds.includes(team.id) ? 'border-primary text-text' : ''}`}
                aria-pressed={c.teamIds.includes(team.id)}
                onClick={() => set(i, { teamIds: toggle(c.teamIds, team.id) })}
              >
                {team.key}
                {team.private && ` · ${t('integrations.chat.private')}`}
              </button>
            ))}
          </div>
          <label className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            {tx('integrations.chat.newIssuesGoTo', {
              select: (
                <select
                  className="input h-7 w-auto min-w-0 max-w-full py-0 text-[12px]"
                  value={c.defaultTeamId ?? ''}
                  onChange={(e) => set(i, { defaultTeamId: e.target.value || null })}
                >
                  <option value="">{t('integrations.chat.defaultTeam')}</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              ),
            })}
          </label>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => onChange([...value, emptyChannel()])}
      >
        <Plus size={12} /> {t('integrations.chat.addChannel')}
      </button>
    </div>
  );
}

/** Connecting or editing a chat integration. */
export function ChatForm({
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
  const form = chatForms()[provider.key]!;
  const config = (existing?.config ?? {}) as Record<string, unknown>;
  const [delivery, setDelivery] = useState(
    String(config.delivery ?? form.deliveries[0]?.key ?? ''),
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      form.fields.map((f) => [f.key, f.secret ? '' : String(config[f.key] ?? '')]),
    ),
  );
  const [channels, setChannels] = useState<ChatChannel[]>(
    (config.channels as ChatChannel[] | undefined) ?? [],
  );
  const [busy, setBusy] = useState(false);
  // Added with "Add to Slack": Slack manages the token and the app decides the delivery.
  const appMode = config.mode === 'app';
  const fields = appMode ? [] : form.fields.filter((f) => !f.for || f.for.includes(delivery));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const cfg: Record<string, unknown> = {
      channels: channels.map((c) => ({ ...c, name: c.name || undefined })),
      ...(delivery && !appMode && { delivery }),
    };
    const secrets: Record<string, string> = {};
    for (const f of fields) (f.secret ? secrets : cfg)[f.key] = values[f.key]!.trim();
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
      if (res.status === 'error')
        toast.error(t('integrations.form.savedButError', { error: res.lastError ?? '' }));
      else
        toast.success(
          existing
            ? t('common.saved')
            : t('integrations.form.connected', { provider: provider.name }),
        );
      onDone();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <p className="mb-4 text-[12.5px] text-muted">
        {appMode
          ? t('integrations.slackApp.connectedWith', {
              team: String(config.team ?? existing?.name ?? ''),
            })
          : form.docs}
      </p>
      {form.deliveries.length > 0 && !appMode && (
        <>
          <div className="mb-1 text-[12px] text-muted">
            {t('integrations.chat.deliveryHeading', { provider: provider.name })}
          </div>
          {form.deliveries.map((d) => (
            <label key={d.key} className="mb-2 flex items-start gap-2 text-[13px]">
              <input
                type="radio"
                className="mt-1 accent-primary"
                checked={delivery === d.key}
                onChange={() => setDelivery(d.key)}
              />
              <span>
                {d.label}
                <span className="block text-[11.5px] text-index">{d.hint}</span>
              </span>
            </label>
          ))}
          <div className="mb-4" />
        </>
      )}
      {fields.map((f) => (
        <FormRow
          key={f.key}
          label={f.label}
          hint={f.secret && existing ? t('integrations.form.keepSecret') : f.hint}
        >
          <input
            className="input font-mono"
            type={f.secret ? 'password' : 'text'}
            autoComplete="off"
            required={!(f.secret && existing)}
            placeholder={f.placeholder}
            value={values[f.key]}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          />
        </FormRow>
      ))}
      <ChannelsEditor value={channels} onChange={setChannels} hint={form.channelHint} />
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {existing ? t('common.save') : t('integrations.form.connect')}
        </button>
      </div>
    </form>
  );
}

// ─── Add to Slack ─────────────────────────────────────────────────────────

interface SlackAppInfo {
  app: { delivery: 'events' | 'socket'; clientId: string } | null;
  canCreate: boolean;
  https: boolean;
  publicUrl: string;
  manifests: { events: string; socket: string } | null;
}

/** The instance's Slack app: set up once by an instance admin (manifest, then credentials). */
function SlackAppForm({ info, onSaved }: { info: SlackAppInfo; onSaved: () => void }) {
  const ws = useWorkspace();
  const form = chatForms().slack!;
  const [delivery, setDelivery] = useState<'events' | 'socket'>(info.app?.delivery ?? 'events');
  const [values, setValues] = useState({
    clientId: info.app?.clientId ?? '',
    clientSecret: '',
    signingSecret: '',
    appToken: '',
  });
  const [busy, setBusy] = useState(false);
  const existing = !!info.app;
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues({ ...values, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put(wsPath(ws.slug, '/integrations/slack/app'), {
        delivery,
        clientId: values.clientId.trim(),
        clientSecret: values.clientSecret.trim() || undefined,
        signingSecret: values.signingSecret.trim() || undefined,
        appToken: delivery === 'socket' ? values.appToken.trim() || undefined : undefined,
      });
      toast.success(t('integrations.slackApp.saved'));
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const secret = (
    key: 'clientSecret' | 'signingSecret' | 'appToken',
    label: string,
    placeholder?: string,
  ) => (
    <FormRow label={label} hint={existing ? t('integrations.form.keepSecret') : undefined}>
      <input
        className="input font-mono"
        type="password"
        autoComplete="off"
        required={!existing}
        placeholder={placeholder}
        value={values[key]}
        onChange={set(key)}
      />
    </FormRow>
  );

  return (
    <form onSubmit={submit}>
      <div className="mb-1 text-[12px] text-muted">{t('integrations.slackApp.step1')}</div>
      {form.deliveries.map((d) => (
        <label key={d.key} className="mb-2 flex items-start gap-2 text-[13px]">
          <input
            type="radio"
            className="mt-1 accent-primary"
            checked={delivery === d.key}
            onChange={() => setDelivery(d.key as 'events' | 'socket')}
          />
          <span>
            {d.label}
            <span className="block text-[11.5px] text-index">{d.hint}</span>
          </span>
        </label>
      ))}
      {info.manifests && (
        <>
          <div className="mt-4 mb-1 text-[12px] text-muted">{t('integrations.slackApp.step2')}</div>
          <p className="mb-2 text-[12.5px] text-muted">{t('integrations.slackApp.step2Body')}</p>
          <a
            className="btn btn-ghost btn-sm"
            href={info.manifests[delivery]}
            target="_blank"
            rel="noreferrer"
          >
            {t('integrations.slackApp.createApp')} <span className="arrow">↗</span>
          </a>
        </>
      )}
      <div className="mt-4 mb-1 text-[12px] text-muted">{t('integrations.slackApp.step3')}</div>
      <p className="mb-3 text-[12.5px] text-muted">
        {delivery === 'socket'
          ? t('integrations.slackApp.step3Socket')
          : t('integrations.slackApp.step3Body')}
      </p>
      <FormRow label={t('integrations.slackApp.clientId')}>
        <input
          className="input font-mono"
          required
          placeholder="1234567890.1234567890"
          value={values.clientId}
          onChange={set('clientId')}
        />
      </FormRow>
      {secret('clientSecret', t('integrations.slackApp.clientSecret'))}
      {secret('signingSecret', t('integrations.chat.slack.signingSecret'))}
      {delivery === 'socket' && secret('appToken', t('integrations.chat.slack.appToken'), 'xapp-…')}
      <button className="btn btn-primary" disabled={busy}>
        {t('integrations.slackApp.save')}
      </button>
    </form>
  );
}

export function SlackAppPanel({ onCancel }: { onCancel: () => void }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'slack-app'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<SlackAppInfo>(wsPath(ws.slug, '/integrations/slack/app')),
  });
  const [changing, setChanging] = useState(false);
  if (!data) return null;

  const install = async () => {
    try {
      const { url } = await api.post<{ url: string }>(
        wsPath(ws.slug, '/integrations/slack/install'),
      );
      window.location.assign(url);
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const saved = () => {
    setChanging(false);
    qc.invalidateQueries({ queryKey: key });
  };

  return (
    <div>
      {!data.https && (
        <p className="mb-4 border border-warning/40 bg-warning/5 p-3 text-[12.5px] text-muted">
          {tx('integrations.slackApp.needsHttps', {
            url: <span className="font-mono">{data.publicUrl}</span>,
          })}
        </p>
      )}
      {data.app ? (
        <>
          <p className="mb-4 text-[12.5px] text-muted">{t('integrations.slackApp.intro')}</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={install}
            disabled={!data.https}
          >
            {t('integrations.slackApp.add')} <span className="arrow">→</span>
          </button>
          {data.canCreate && (
            <div className="mt-6 border-t border-border-soft pt-4">
              {changing ? (
                <>
                  <p className="mb-4 text-[12.5px] text-muted">
                    {t('integrations.slackApp.changeHint')}
                  </p>
                  <SlackAppForm info={data} onSaved={saved} />
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setChanging(true)}
                >
                  {t('integrations.slackApp.change')}
                </button>
              )}
            </div>
          )}
        </>
      ) : data.canCreate ? (
        <>
          <p className="mb-4 text-[12.5px] text-muted">{t('integrations.slackApp.setupIntro')}</p>
          <SlackAppForm info={data} onSaved={saved} />
        </>
      ) : (
        <p className="text-[13px] text-muted">{t('integrations.slackApp.needsInstanceAdmin')}</p>
      )}
      <div className="mt-6 flex justify-end">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

// ─── Account → Chat accounts ─────────────────────────────────────────────

/** People link their chat accounts by sending a one-time code from them. */
export function ChatAccountsCard() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'chat-accounts'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ services: ChatService[] }>(wsPath(ws.slug, '/me/chat-accounts')),
    // Linking happens in the chat app; pick it up when the person comes back.
    refetchOnWindowFocus: true,
  });
  const [codes, setCodes] = useState<Record<string, { code: string; hint: string }>>({});
  if (!data?.services.length) return null;
  const reload = () => qc.invalidateQueries({ queryKey: key });

  return (
    <SettingsCard
      title={t('integrations.chatAccounts.title')}
      description={t('integrations.chatAccounts.description')}
    >
      {data.services.map((s) => {
        const pending = codes[s.integrationId];
        return (
          <div key={s.integrationId} className="border-b border-border-soft py-3">
            <div className="mb-2 flex items-center gap-2 text-[13px]">
              <span className="flex-1">{s.name}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  try {
                    const res = await api.post<{ code: string; hint: string }>(
                      wsPath(ws.slug, `/me/chat-accounts/${s.integrationId}/code`),
                    );
                    setCodes({ ...codes, [s.integrationId]: res });
                  } catch (err) {
                    toast.error(errMsg(err));
                  }
                }}
              >
                <Link2 size={12} />{' '}
                {s.accounts.length
                  ? t('integrations.chatAccounts.linkAnother')
                  : t('integrations.chatAccounts.linkAccount')}
              </button>
            </div>
            {pending && (
              <div className="mb-2 border border-border-soft bg-bg p-3 text-[12.5px]">
                <div className="mb-1 text-muted">
                  {t('integrations.chatAccounts.send', {
                    command: pending.hint.replace('CODE', pending.code),
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <code className="font-mono text-[15px] tracking-[0.12em] text-highlight">
                    {pending.code}
                  </code>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={t('integrations.chatAccounts.copyCode')}
                    onClick={() => {
                      void navigator.clipboard?.writeText(pending.code);
                      toast.success(t('common.copied'));
                    }}
                  >
                    <Copy size={12} />
                  </button>
                  <span className="text-[11.5px] text-index">
                    {t('integrations.chatAccounts.validity')}
                  </span>
                </div>
              </div>
            )}
            {s.accounts.map((a) => (
              <div key={a.id} className="flex items-center gap-2 py-1 text-[12.5px]">
                <span className="flex-1 font-mono">
                  {a.username ?? t('integrations.chatAccounts.linkedAccount')}
                  <span className="ml-2 text-index">
                    {t('integrations.chatAccounts.linkedAgo', { time: relativeTime(a.createdAt) })}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title={
                    a.notify
                      ? t('integrations.chatAccounts.notificationsOn')
                      : t('integrations.chatAccounts.notificationsOff')
                  }
                  aria-label={
                    a.notify
                      ? t('integrations.chatAccounts.turnNotificationsOff')
                      : t('integrations.chatAccounts.turnNotificationsOn')
                  }
                  onClick={async () => {
                    await api.patch(wsPath(ws.slug, `/me/chat-accounts/${a.id}`), {
                      notify: !a.notify,
                    });
                    reload();
                  }}
                >
                  {a.notify ? <BellRing size={12} /> : <BellOff size={12} />}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('integrations.chatAccounts.unlink')}
                  onClick={async () => {
                    if (
                      !(await confirmDialog({
                        title: t('integrations.chatAccounts.confirmUnlinkTitle', {
                          service: s.name,
                        }),
                        body: t('integrations.chatAccounts.confirmUnlinkBody'),
                        confirmLabel: t('integrations.chatAccounts.unlink'),
                        danger: true,
                      }))
                    )
                      return;
                    await api.del(wsPath(ws.slug, `/me/chat-accounts/${a.id}`));
                    reload();
                  }}
                >
                  <Unlink size={12} />
                </button>
              </div>
            ))}
          </div>
        );
      })}
    </SettingsCard>
  );
}
