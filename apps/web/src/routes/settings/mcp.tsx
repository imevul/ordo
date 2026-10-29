import { MCP_TOOLS } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Bot, Copy, KeyRound, Plug, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client.ts';
import { keys, useOAuthGrants } from '../../api/queries.ts';
import { confirmDialog } from '../../components/ui/Modal.tsx';
import { t, tx } from '../../i18n/index.ts';
import { relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));
const PLACEHOLDER = 'YOUR_ORDO_API_KEY';

function copy(text: string) {
  navigator.clipboard?.writeText(text);
  toast.success(t('common.copied'));
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm flex-none" onClick={() => copy(text)}>
      <Copy size={12} /> {label ?? t('common.copy')}
    </button>
  );
}

/** A block of text to paste somewhere, with a copy button. */
function Snippet({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="max-h-96 overflow-auto border border-border-soft bg-bg p-3 pr-24 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
        {text}
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton text={text} />
      </div>
    </div>
  );
}

type Auth = 'oauth' | 'key';

interface Setup {
  where: string;
  snippet: (url: string, name: string, key: string) => string;
}

interface Client {
  key: string;
  label: string;
  /** How to connect with OAuth sign-in and with an API key; a client may support only one. */
  oauth?: Setup;
  apiKey?: Setup;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** The MCP clients with setup help. A function: the instructions follow the language. */
const clients = (): Client[] => [
  {
    key: 'claude',
    label: 'claude.ai',
    oauth: {
      where: t('mcp.setup.claudeOauth'),
      snippet: (url) => url,
    },
    apiKey: {
      where: t('mcp.setup.claudeKey'),
      snippet: (url, name, key) =>
        json({
          mcpServers: {
            [name]: {
              command: 'npx',
              // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by mcp-remote
              args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${ORDO_AUTH}'],
              env: { ORDO_AUTH: `Bearer ${key}` },
            },
          },
        }),
    },
  },
  {
    key: 'claude-code',
    label: 'Claude Code',
    oauth: {
      where: t('mcp.setup.claudeCodeOauth'),
      snippet: (url, name) => `claude mcp add --transport http --scope user ${name} ${url}`,
    },
    apiKey: {
      where: t('mcp.setup.claudeCodeKey'),
      snippet: (url, name, key) =>
        `claude mcp add --transport http --scope user ${name} ${url} \\\n  --header "Authorization: Bearer ${key}"`,
    },
  },
  {
    key: 'cursor',
    label: 'Cursor',
    oauth: {
      where: t('mcp.setup.cursorOauth'),
      snippet: (url, name) => json({ mcpServers: { [name]: { url } } }),
    },
    apiKey: {
      where: t('mcp.setup.cursorKey'),
      snippet: (url, name, key) =>
        json({ mcpServers: { [name]: { url, headers: { Authorization: `Bearer ${key}` } } } }),
    },
  },
  {
    key: 'vscode',
    label: 'VS Code',
    oauth: {
      where: t('mcp.setup.vscodeOauth'),
      snippet: (url, name) => json({ servers: { [name]: { type: 'http', url } } }),
    },
    apiKey: {
      where: t('mcp.setup.vscodeKey'),
      snippet: (url, name) =>
        json({
          inputs: [
            {
              type: 'promptString',
              id: 'ordo-api-key',
              description: 'Ordo API key',
              password: true,
            },
          ],
          servers: {
            [name]: {
              type: 'http',
              url,
              // biome-ignore lint/suspicious/noTemplateCurlyInString: a VS Code input variable
              headers: { Authorization: 'Bearer ${input:ordo-api-key}' },
            },
          },
        }),
    },
  },
  {
    key: 'other',
    label: t('mcp.setup.otherClient'),
    oauth: {
      where: t('mcp.setup.otherOauth'),
      snippet: (url) =>
        `URL:       ${url}\nTransport: Streamable HTTP\nAuth:      OAuth (discovered from the URL)`,
    },
    apiKey: {
      where: t('mcp.setup.otherKey'),
      snippet: (url, _name, key) =>
        `URL:       ${url}\nTransport: Streamable HTTP\nHeader:    Authorization: Bearer ${key}`,
    },
  },
];

function agentPrompt(opts: {
  url: string;
  name: string;
  workspace: string;
  auth: Auth;
  key: string | null;
}) {
  const { url, name, workspace, auth, key } = opts;
  if (auth === 'oauth') return t('mcp.agent.promptOauth', { url, name, workspace });
  const keyLine = key ? t('mcp.agent.promptKeyGiven', { key }) : t('mcp.agent.promptKeyLater');
  return t('mcp.agent.promptKey', { url, name, workspace, keyLine });
}

/** Apps signed in with OAuth, in every workspace. */
function ConnectedAppsCard() {
  const qc = useQueryClient();
  const { data: grants = [] } = useOAuthGrants();
  const disconnect = async (id: string, name: string) => {
    if (
      !(await confirmDialog({
        title: t('mcp.apps.confirmDisconnectTitle', { name }),
        body: t('mcp.apps.confirmDisconnectBody'),
        confirmLabel: t('mcp.apps.disconnect'),
        danger: true,
      }))
    )
      return;
    try {
      await api.del(`/me/oauth-grants/${id}`);
      qc.invalidateQueries({ queryKey: keys.oauthGrants });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <SettingsCard title={t('mcp.apps.title')} description={t('mcp.apps.description')}>
      {grants.map((g) => (
        <div key={g.id} className="flex h-12 items-center gap-3 border-b border-border-soft">
          <Plug size={14} className="flex-none text-muted" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 truncate text-[13.5px]">
              {g.client.name}
              {g.client.verified && (
                <BadgeCheck
                  size={12}
                  className="flex-none text-muted"
                  aria-label={t('mcp.apps.verified')}
                />
              )}
            </div>
            <div className="truncate font-mono text-[11px] text-index">
              {g.client.host} · {g.workspace.name}
            </div>
          </div>
          <span className="hidden w-32 text-right font-mono text-[11px] text-index sm:block">
            {g.lastUsedAt
              ? t('mcp.apps.used', { time: relativeTime(g.lastUsedAt) })
              : t('mcp.apps.added', { time: relativeTime(g.createdAt) })}
          </span>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => disconnect(g.id, g.client.name)}
            aria-label={t('mcp.apps.disconnectName', { name: g.client.name })}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {grants.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('mcp.apps.empty')}</p>
      )}
    </SettingsCard>
  );
}

export function McpSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const url = `${window.location.origin}/api/w/${ws.slug}/mcp`;
  const name = `ordo-${ws.slug}`;
  const clientList = clients();
  const [client, setClient] = useState(clientList[0]!.key);
  const [auth, setAuth] = useState<Auth>('oauth');
  const [keyName, setKeyName] = useState(() => t('mcp.key.defaultName'));
  const [created, setCreated] = useState<string | null>(null);
  const [keyInSnippets, setKeyInSnippets] = useState(true);
  const [keyInPrompt, setKeyInPrompt] = useState(false);
  const { requireSso, allowApiKeysUnderSso } = ws.workspace.settings;
  const blocked = requireSso && !allowApiKeysUnderSso && !ws.isOwner;
  const active = clientList.find((c) => c.key === client)!;
  const setup = auth === 'oauth' ? active.oauth : active.apiKey;
  const snippetKey = created && keyInSnippets ? created : PLACEHOLDER;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<{ token: string }>('/me/api-keys', { name: keyName });
      setCreated(res.token);
      qc.invalidateQueries({ queryKey: keys.apiKeys });
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <>
      <SettingsCard
        title={t('mcp.connect.title')}
        description={tx('mcp.connect.description', {
          workspace: <span className="text-text">{ws.workspace.name}</span>,
          doc: <span className="font-mono">docs/mcp.md</span>,
        })}
      >
        {blocked && auth === 'key' && (
          <div className="panel panel-sm mb-5 p-4 [--panel-border:var(--color-warning)]">
            <div className="kicker mb-1 text-warning">{t('mcp.connect.blockedKicker')}</div>
            <p className="text-[13px] text-muted">
              {t('mcp.connect.blockedBody', { workspace: ws.workspace.name })}
            </p>
          </div>
        )}
        <FormRow label={t('mcp.connect.serverUrl')} hint={t('mcp.connect.serverUrlHint')}>
          <div className="flex gap-2">
            <input className="input font-mono text-[12.5px]" value={url} readOnly />
            <CopyButton text={url} />
          </div>
        </FormRow>
        <FormRow label={t('mcp.connect.signInWith')} hint={t('mcp.connect.signInWithHint')}>
          <div role="radiogroup" aria-label={t('mcp.connect.signInWith')} className="flex gap-1">
            {(
              [
                ['oauth', 'OAuth'],
                ['key', t('mcp.connect.apiKey')],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={auth === value}
                onClick={() => setAuth(value)}
                className={`h-7 px-3 font-mono text-[11px] tracking-[0.1em] uppercase transition-colors ${auth === value ? 'bg-raised text-primary' : 'text-index hover:text-text'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </FormRow>
      </SettingsCard>

      {auth === 'key' && (
        <SettingsCard title={t('mcp.key.title')} description={t('mcp.key.description')}>
          <form onSubmit={create} className="mb-4 flex gap-2">
            <input
              className="input"
              aria-label={t('mcp.key.nameLabel')}
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              required
            />
            <button className="btn btn-primary flex-none" disabled={!!created}>
              <KeyRound size={13} /> {t('mcp.key.create')}
            </button>
          </form>
          {created && (
            <div className="panel panel-sm p-4 [--panel-border:var(--color-primary)]">
              <div className="kicker mb-2">{t('mcp.key.copyNow')}</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{created}</code>
                <CopyButton text={created} />
              </div>
              <label className="mt-3 flex items-center gap-2 text-[12.5px] text-muted">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={keyInSnippets}
                  onChange={(e) => setKeyInSnippets(e.target.checked)}
                />
                {t('mcp.key.fillIntoSnippets')}
              </label>
            </div>
          )}
        </SettingsCard>
      )}

      <SettingsCard
        title={t('mcp.setup.title')}
        description={setup?.where ?? t('mcp.setup.cantConnect', { client: active.label })}
      >
        <div
          role="tablist"
          aria-label={t('mcp.setup.clientsLabel')}
          className="mb-3 flex flex-wrap gap-1"
        >
          {clientList.map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={c.key === client}
              onClick={() => setClient(c.key)}
              className={`h-6 px-2.5 font-mono text-[11px] leading-6 tracking-[0.1em] uppercase transition-colors ${c.key === client ? 'bg-raised text-primary' : 'text-index hover:text-text'}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {setup && <Snippet text={setup.snippet(url, name, snippetKey)} />}
        {setup && auth === 'key' && snippetKey === PLACEHOLDER && active.key !== 'vscode' && (
          <p className="mt-2 text-[11.5px] text-index">
            {t('mcp.setup.replacePlaceholder', { placeholder: PLACEHOLDER })}
          </p>
        )}
      </SettingsCard>

      <SettingsCard title={t('mcp.agent.title')} description={t('mcp.agent.description')}>
        {created && auth === 'key' && (
          <label className="mb-3 flex items-center gap-2 text-[12.5px] text-muted">
            <input
              type="checkbox"
              className="accent-primary"
              checked={keyInPrompt}
              onChange={(e) => setKeyInPrompt(e.target.checked)}
            />
            {t('mcp.agent.includeKey')}
          </label>
        )}
        <Snippet
          text={agentPrompt({
            url,
            name,
            workspace: ws.workspace.name,
            auth,
            key: created && keyInPrompt ? created : null,
          })}
        />
      </SettingsCard>

      <SettingsCard title={t('mcp.tools.title')} description={t('mcp.tools.description')}>
        {MCP_TOOLS.map((tool) => (
          <div
            key={tool.name}
            className="flex items-start gap-3 border-b border-border-soft py-2.5"
          >
            <Bot size={14} className="mt-0.5 flex-none text-muted" />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[12.5px]">{tool.name}</div>
              <div className="text-[12.5px] text-muted">
                {t(`mcp.tools.descriptions.${tool.name}`)}
              </div>
            </div>
            {tool.audience === 'agent' && (
              <span className="tag flex-none">{t('mcp.tools.agentsOnly')}</span>
            )}
            <span className="tag flex-none">
              {tool.readOnly ? t('mcp.tools.read') : t('mcp.tools.write')}
            </span>
          </div>
        ))}
      </SettingsCard>
      <ConnectedAppsCard />
    </>
  );
}
