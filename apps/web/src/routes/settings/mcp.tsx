import { MCP_TOOLS } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Bot, Copy, KeyRound, Plug, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client.ts';
import { keys, useOAuthGrants } from '../../api/queries.ts';
import { confirmDialog } from '../../components/ui/Modal.tsx';
import { relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
const PLACEHOLDER = 'YOUR_ORDO_API_KEY';

function copy(text: string) {
  navigator.clipboard?.writeText(text);
  toast.success('Copied');
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm flex-none" onClick={() => copy(text)}>
      <Copy size={12} /> {label}
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

const CLIENTS: Client[] = [
  {
    key: 'claude',
    label: 'claude.ai',
    oauth: {
      where:
        'In claude.ai or Claude Desktop: Settings → Connectors → Add custom connector, and paste the URL. Claude then opens Ordo so you can allow it.',
      snippet: (url) => url,
    },
    apiKey: {
      where:
        'Claude Desktop only: Settings → Developer → Edit config (claude_desktop_config.json), then restart Claude. Uses the mcp-remote bridge, which needs Node.js.',
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
      where:
        'Run in a terminal, then type /mcp in Claude Code and pick the server to sign in. --scope user makes Ordo available in every project.',
      snippet: (url, name) => `claude mcp add --transport http --scope user ${name} ${url}`,
    },
    apiKey: {
      where: 'Run in a terminal. --scope user makes Ordo available in every project.',
      snippet: (url, name, key) =>
        `claude mcp add --transport http --scope user ${name} ${url} \\\n  --header "Authorization: Bearer ${key}"`,
    },
  },
  {
    key: 'cursor',
    label: 'Cursor',
    oauth: {
      where:
        '~/.cursor/mcp.json (all projects) or .cursor/mcp.json in a project. Cursor asks you to sign in when it first connects.',
      snippet: (url, name) => json({ mcpServers: { [name]: { url } } }),
    },
    apiKey: {
      where: '~/.cursor/mcp.json (all projects) or .cursor/mcp.json in a project.',
      snippet: (url, name, key) =>
        json({ mcpServers: { [name]: { url, headers: { Authorization: `Bearer ${key}` } } } }),
    },
  },
  {
    key: 'vscode',
    label: 'VS Code',
    oauth: {
      where:
        '.vscode/mcp.json, or "MCP: Open User Configuration". VS Code asks you to sign in when the server starts.',
      snippet: (url, name) => json({ servers: { [name]: { type: 'http', url } } }),
    },
    apiKey: {
      where:
        '.vscode/mcp.json, or "MCP: Open User Configuration". VS Code asks for the key once and keeps it in its secret storage.',
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
    label: 'Other',
    oauth: {
      where:
        'Any MCP client that supports the Streamable HTTP transport and OAuth. It finds out how to sign in from the URL.',
      snippet: (url) =>
        `URL:       ${url}\nTransport: Streamable HTTP\nAuth:      OAuth (discovered from the URL)`,
    },
    apiKey: {
      where: 'Any MCP client that supports the Streamable HTTP transport and custom headers.',
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
  if (auth === 'oauth')
    return `Please connect yourself to Ordo, our issue tracker, through its MCP server.

- Server URL: ${url}
- Transport: Streamable HTTP (workspace "${workspace}")
- Auth: OAuth. The server tells your MCP client how to sign in; I'll approve it in my browser.

Steps:
1. Work out which MCP client you are running in and add the server to its user-level MCP configuration under the name "${name}", with no headers. In Claude Code that is:
   claude mcp add --transport http --scope user ${name} ${url}
   In Cursor or VS Code, edit their MCP config file instead (see Ordo → Settings → AI agents for the exact format).
2. Tell me how to start the sign-in (in Claude Code: run /mcp and pick "${name}"), or reload the MCP servers if your client starts it on its own.
3. Once I've approved it, verify the connection by calling the list_teams tool and show me the team keys you get back.
   - 404 means the URL is wrong or I'm not a member of that workspace.

The Ordo tools act as me, with my permissions. Ask me before creating or changing issues unless I asked you to.`;
  const keyLine = key
    ? `The key is ${key}. Store it in your client's MCP config or an environment variable, never in a file that is committed to git, and don't repeat it back to me.`
    : "I'll give you the key when you ask for it (or it's in the ORDO_API_KEY environment variable). Never write it into a file that is committed to git, and don't repeat it back to me.";
  return `Please connect yourself to Ordo, our issue tracker, through its MCP server.

- Server URL: ${url}
- Transport: Streamable HTTP (workspace "${workspace}")
- Auth: my personal Ordo API key, sent as the HTTP header "Authorization: Bearer <key>".
  ${keyLine}

Steps:
1. Work out which MCP client you are running in and add the server to its user-level MCP configuration under the name "${name}". In Claude Code that is:
   claude mcp add --transport http --scope user ${name} ${url} --header "Authorization: Bearer $ORDO_API_KEY"
   In Cursor, VS Code or Claude Desktop, edit their MCP config file instead (see Ordo → Settings → AI agents for the exact format).
2. Reload the MCP servers or tell me if I need to restart you.
3. Verify the connection by calling the list_teams tool and show me the team keys you get back.
   - 401 means the key is wrong or was revoked.
   - 403 means the workspace requires SSO and doesn't allow API keys.
   - 404 means the URL is wrong or I'm not a member of that workspace.

The Ordo tools act as me, with my permissions. Ask me before creating or changing issues unless I asked you to.`;
}

/** Apps signed in with OAuth, in every workspace. */
function ConnectedAppsCard() {
  const qc = useQueryClient();
  const { data: grants = [] } = useOAuthGrants();
  const disconnect = async (id: string, name: string) => {
    if (
      !(await confirmDialog({
        title: `Disconnect ${name}?`,
        body: 'It loses access right away and has to ask again to reconnect.',
        confirmLabel: 'Disconnect',
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
    <SettingsCard
      title="Connected apps"
      description="Apps you allowed to use Ordo’s MCP server as you, in any workspace."
    >
      {grants.map((g) => (
        <div key={g.id} className="flex h-12 items-center gap-3 border-b border-border-soft">
          <Plug size={14} className="flex-none text-muted" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 truncate text-[13.5px]">
              {g.client.name}
              {g.client.verified && (
                <BadgeCheck size={12} className="flex-none text-muted" aria-label="Verified" />
              )}
            </div>
            <div className="truncate font-mono text-[11px] text-index">
              {g.client.host} · {g.workspace.name}
            </div>
          </div>
          <span className="hidden w-32 text-right font-mono text-[11px] text-index sm:block">
            {g.lastUsedAt
              ? `used ${relativeTime(g.lastUsedAt)}`
              : `added ${relativeTime(g.createdAt)}`}
          </span>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => disconnect(g.id, g.client.name)}
            aria-label={`Disconnect ${g.client.name}`}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {grants.length === 0 && (
        <p className="font-mono text-[12px] text-index">// no apps connected</p>
      )}
    </SettingsCard>
  );
}

export function McpSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const url = `${window.location.origin}/api/w/${ws.slug}/mcp`;
  const name = `ordo-${ws.slug}`;
  const [client, setClient] = useState(CLIENTS[0]!.key);
  const [auth, setAuth] = useState<Auth>('oauth');
  const [keyName, setKeyName] = useState('AI agent');
  const [created, setCreated] = useState<string | null>(null);
  const [keyInSnippets, setKeyInSnippets] = useState(true);
  const [keyInPrompt, setKeyInPrompt] = useState(false);
  const { requireSso, allowApiKeysUnderSso } = ws.workspace.settings;
  const blocked = requireSso && !allowApiKeysUnderSso && !ws.isOwner;
  const active = CLIENTS.find((c) => c.key === client)!;
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
        title="Connect an AI agent"
        description={
          <>
            Ordo runs an MCP server for <span className="text-text">{ws.workspace.name}</span>.
            Agents such as Claude, Claude Code, Cursor or VS Code connect to it and act as you: they
            see the teams you can see, and what they change shows up under your name. Most sign in
            with OAuth — you approve them in the browser and can disconnect them below. Others use
            one of your API keys. See <span className="font-mono">docs/mcp.md</span>.
          </>
        }
      >
        {blocked && auth === 'key' && (
          <div className="panel panel-sm mb-5 p-4 [--panel-border:var(--color-warning)]">
            <div className="kicker mb-1 text-warning">// api keys are blocked here</div>
            <p className="text-[13px] text-muted">
              {ws.workspace.name} requires SSO and doesn’t allow API keys. Sign agents in with OAuth
              instead, or ask an admin to allow keys under Settings → Authentication.
            </p>
          </div>
        )}
        <FormRow label="Server URL" hint="One URL per workspace. The transport is Streamable HTTP.">
          <div className="flex gap-2">
            <input className="input font-mono text-[12.5px]" value={url} readOnly />
            <CopyButton text={url} />
          </div>
        </FormRow>
        <FormRow label="Sign in with" hint="OAuth needs no key; use a key for clients without it.">
          <div role="radiogroup" aria-label="Sign in with" className="flex gap-1">
            {(
              [
                ['oauth', 'OAuth'],
                ['key', 'API key'],
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
        <SettingsCard
          title="Create a key for the agent"
          description="A personal API key, shown once. You can revoke it any time under API keys."
        >
          <form onSubmit={create} className="mb-4 flex gap-2">
            <input
              className="input"
              aria-label="Key name"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              required
            />
            <button className="btn btn-primary flex-none" disabled={!!created}>
              <KeyRound size={13} /> Create key
            </button>
          </form>
          {created && (
            <div className="panel panel-sm p-4 [--panel-border:var(--color-primary)]">
              <div className="kicker mb-2">// copy it now — it won't be shown again</div>
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
                Fill this key into the setup snippets below
              </label>
            </div>
          )}
        </SettingsCard>
      )}

      <SettingsCard
        title="Set it up yourself"
        description={setup?.where ?? `${active.label} can’t connect this way.`}
      >
        <div role="tablist" aria-label="MCP client" className="mb-3 flex flex-wrap gap-1">
          {CLIENTS.map((c) => (
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
          <p className="mt-2 text-[11.5px] text-index">Replace {PLACEHOLDER} with your key.</p>
        )}
      </SettingsCard>

      <SettingsCard
        title="Or let your agent do it"
        description="Paste this into your coding agent. It adds the server to its own MCP config and checks the connection with a test call."
      >
        {created && auth === 'key' && (
          <label className="mb-3 flex items-center gap-2 text-[12.5px] text-muted">
            <input
              type="checkbox"
              className="accent-primary"
              checked={keyInPrompt}
              onChange={(e) => setKeyInPrompt(e.target.checked)}
            />
            Include the key I just created in the prompt
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

      <SettingsCard
        title="What the agent can do"
        description="Tools take team keys, issue identifiers, status and label names, and usernames."
      >
        {MCP_TOOLS.map((t) => (
          <div key={t.name} className="flex items-start gap-3 border-b border-border-soft py-2.5">
            <Bot size={14} className="mt-0.5 flex-none text-muted" />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[12.5px]">{t.name}</div>
              <div className="text-[12.5px] text-muted">{t.description}</div>
            </div>
            <span className="tag flex-none">{t.readOnly ? 'read' : 'write'}</span>
          </div>
        ))}
      </SettingsCard>
      <ConnectedAppsCard />
    </>
  );
}
