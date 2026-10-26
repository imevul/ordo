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
import { relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

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

/** What each chat service needs. See docs/integrations for the matching app setup. */
export const CHAT_FORMS: Record<string, ChatForm> = {
  slack: {
    docs: 'Create a Slack app from the manifest in the Ordo docs, install it to your workspace, then paste its tokens.',
    channelHint:
      'Channel ids look like C0123ABCD (channel details → About). Invite the app to the channel.',
    deliveries: [
      {
        key: 'events',
        label: 'Events API',
        hint: 'Slack posts to Ordo; it must reach this server.',
      },
      {
        key: 'socket',
        label: 'Socket Mode',
        hint: 'Ordo keeps a connection open to Slack. Works behind NAT and firewalls.',
      },
    ],
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true, placeholder: 'xoxb-…' },
      { key: 'signingSecret', label: 'Signing secret', secret: true, for: ['events'] },
      {
        key: 'appToken',
        label: 'App-level token',
        secret: true,
        placeholder: 'xapp-…',
        hint: 'With the connections:write scope.',
        for: ['socket'],
      },
    ],
  },
  discord: {
    docs: 'Create an application in the Discord developer portal, add a bot with the Message Content intent, and invite it with the bot and applications.commands scopes.',
    channelHint:
      'Channel ids are numbers (enable developer mode, then right-click → Copy channel ID).',
    deliveries: [
      {
        key: 'interactions',
        label: 'Interactions endpoint',
        hint: 'Discord posts slash commands to Ordo; it must reach this server.',
      },
      {
        key: 'gateway',
        label: 'Gateway',
        hint: 'Ordo keeps a connection open to Discord. Works behind NAT; also answers !ordo messages and previews links.',
      },
    ],
    fields: [
      { key: 'applicationId', label: 'Application id', placeholder: '1234567890' },
      { key: 'botToken', label: 'Bot token', secret: true },
      {
        key: 'publicKey',
        label: 'Public key',
        secret: true,
        hint: 'From General information; it verifies requests from Discord.',
        for: ['interactions'],
      },
    ],
  },
  matrix: {
    docs: 'Register an account for the bot on your homeserver and paste its access token. Ordo syncs from your homeserver, so nothing has to reach Ordo. Encrypted rooms are not supported.',
    channelHint: 'Room ids look like !abc123:example.org (room settings → Advanced).',
    deliveries: [],
    fields: [
      { key: 'homeserverUrl', label: 'Homeserver URL', placeholder: 'https://matrix.example.org' },
      { key: 'accessToken', label: 'Access token', secret: true },
    ],
  },
  telegram: {
    docs: 'Create a bot with @BotFather and paste its token. To see issue links in groups, turn the bot’s privacy mode off.',
    channelHint: 'Group ids are negative numbers, e.g. -1001234567890.',
    deliveries: [
      {
        key: 'webhook',
        label: 'Webhook',
        hint: 'Telegram posts to Ordo; it must reach this server over HTTPS.',
      },
      {
        key: 'longpoll',
        label: 'Long polling',
        hint: 'Ordo asks Telegram for updates. Works behind NAT.',
      },
    ],
    fields: [{ key: 'botToken', label: 'Bot token', secret: true, placeholder: '123456:ABC…' }],
  },
};

const EVENT_LABELS: Record<ChatEventKind, string> = {
  'issue.created': 'New issues',
  'issue.status': 'Status changes',
  'issue.completed': 'Completed issues',
  'comment.created': 'Comments',
  'project_update.created': 'Project updates',
};

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
      <div className="mb-1 text-[12px] text-muted">Channels</div>
      <p className="mb-2 text-[11.5px] text-index">{hint}</p>
      {value.map((c, i) => (
        <div key={i} className="mb-2 border border-border-soft bg-bg p-3">
          <div className="mb-2 flex gap-2">
            <input
              className="input flex-1 font-mono"
              placeholder="Channel id"
              aria-label="Channel id"
              required
              value={c.id}
              onChange={(e) => set(i, { id: e.target.value })}
            />
            <input
              className="input w-36"
              placeholder="Name (optional)"
              aria-label="Channel name"
              value={c.name ?? ''}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Remove channel"
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
                {EVENT_LABELS[k]}
              </label>
            ))}
          </div>
          <div className="mb-1 text-[11.5px] text-index">
            From {c.teamIds.length ? 'these teams' : 'every public team'}:
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {teams.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`tag font-mono ${c.teamIds.includes(t.id) ? 'border-primary text-text' : ''}`}
                aria-pressed={c.teamIds.includes(t.id)}
                onClick={() => set(i, { teamIds: toggle(c.teamIds, t.id) })}
              >
                {t.key}
                {t.private && ' · private'}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[12px] text-muted">
            New issues from here go to
            <select
              className="input h-7 w-auto py-0 text-[12px]"
              value={c.defaultTeamId ?? ''}
              onChange={(e) => set(i, { defaultTeamId: e.target.value || null })}
            >
              <option value="">the workspace default team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => onChange([...value, emptyChannel()])}
      >
        <Plus size={12} /> Add channel
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
  const form = CHAT_FORMS[provider.key]!;
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
  const fields = form.fields.filter((f) => !f.for || f.for.includes(delivery));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const cfg: Record<string, unknown> = {
      channels: channels.map((c) => ({ ...c, name: c.name || undefined })),
      ...(delivery && { delivery }),
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
      {form.deliveries.length > 0 && (
        <>
          <div className="mb-1 text-[12px] text-muted">How Ordo hears from {provider.name}</div>
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
          hint={f.secret && existing ? 'Leave empty to keep the current one.' : f.hint}
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
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {existing ? 'Save' : 'Connect'}
        </button>
      </div>
    </form>
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
      title="Chat"
      description="Link your chat accounts to get notifications as direct messages and to create issues from chat as yourself."
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
                <Link2 size={12} /> {s.accounts.length ? 'Link another' : 'Link account'}
              </button>
            </div>
            {pending && (
              <div className="mb-2 border border-border-soft bg-bg p-3 text-[12.5px]">
                <div className="mb-1 text-muted">
                  Send {pending.hint.replace('CODE', pending.code)}
                </div>
                <div className="flex items-center gap-2">
                  <code className="font-mono text-[15px] tracking-[0.12em] text-highlight">
                    {pending.code}
                  </code>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label="Copy code"
                    onClick={() => {
                      void navigator.clipboard?.writeText(pending.code);
                      toast.success('Copied');
                    }}
                  >
                    <Copy size={12} />
                  </button>
                  <span className="text-[11.5px] text-index">valid for 15 minutes, once</span>
                </div>
              </div>
            )}
            {s.accounts.map((a) => (
              <div key={a.id} className="flex items-center gap-2 py-1 text-[12.5px]">
                <span className="flex-1 font-mono">
                  {a.username ?? 'linked account'}
                  <span className="ml-2 text-index">linked {relativeTime(a.createdAt)}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title={a.notify ? 'Notifications on' : 'Notifications off'}
                  aria-label={a.notify ? 'Turn notifications off' : 'Turn notifications on'}
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
                  aria-label="Unlink"
                  onClick={async () => {
                    if (
                      !(await confirmDialog({
                        title: `Unlink this ${s.name} account?`,
                        body: 'You will stop getting notifications there.',
                        confirmLabel: 'Unlink',
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
