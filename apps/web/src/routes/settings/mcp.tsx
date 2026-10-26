import { MCP_TOOLS } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Copy, KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client.ts';
import { keys } from '../../api/queries.ts';
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

interface Client {
  key: string;
  label: string;
  where: string;
  snippet: (url: string, name: string, key: string) => string;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

const CLIENTS: Client[] = [
  {
    key: 'claude-code',
    label: 'Claude Code',
    where: 'Run in a terminal. --scope user makes Ordo available in every project.',
    snippet: (url, name, key) =>
      `claude mcp add --transport http --scope user ${name} ${url} \\\n  --header "Authorization: Bearer ${key}"`,
  },
  {
    key: 'claude-desktop',
    label: 'Claude Desktop',
    where:
      'Settings → Developer → Edit config (claude_desktop_config.json), then restart Claude. Uses the mcp-remote bridge, which needs Node.js.',
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
  {
    key: 'cursor',
    label: 'Cursor',
    where: '~/.cursor/mcp.json (all projects) or .cursor/mcp.json in a project.',
    snippet: (url, name, key) =>
      json({ mcpServers: { [name]: { url, headers: { Authorization: `Bearer ${key}` } } } }),
  },
  {
    key: 'vscode',
    label: 'VS Code',
    where:
      '.vscode/mcp.json, or "MCP: Open User Configuration". VS Code asks for the key once and keeps it in its secret storage.',
    snippet: (url, name) =>
      json({
        inputs: [
          { type: 'promptString', id: 'ordo-api-key', description: 'Ordo API key', password: true },
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
  {
    key: 'other',
    label: 'Other',
    where:
      'Any MCP client that supports the Streamable HTTP transport and custom headers. Connectors in claude.ai sign in with OAuth, which Ordo doesn’t offer yet, so use Claude Desktop or Claude Code there.',
    snippet: (url, _name, key) =>
      `URL:       ${url}\nTransport: Streamable HTTP\nHeader:    Authorization: Bearer ${key}`,
  },
];

function agentPrompt(opts: { url: string; name: string; workspace: string; key: string | null }) {
  const { url, name, workspace, key } = opts;
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

export function McpSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const url = `${window.location.origin}/api/w/${ws.slug}/mcp`;
  const name = `ordo-${ws.slug}`;
  const [client, setClient] = useState(CLIENTS[0]!.key);
  const [keyName, setKeyName] = useState('AI agent');
  const [created, setCreated] = useState<string | null>(null);
  const [keyInSnippets, setKeyInSnippets] = useState(true);
  const [keyInPrompt, setKeyInPrompt] = useState(false);
  const { requireSso, allowApiKeysUnderSso } = ws.workspace.settings;
  const blocked = requireSso && !allowApiKeysUnderSso && !ws.isOwner;
  const active = CLIENTS.find((c) => c.key === client)!;
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
            Agents such as Claude Code, Claude Desktop, Cursor or VS Code connect to it with one of
            your API keys and act as you: they see the teams you can see, and what they change shows
            up under your name. See <span className="font-mono">docs/mcp.md</span>.
          </>
        }
      >
        {blocked && (
          <div className="panel panel-sm mb-5 p-4 [--panel-border:var(--color-warning)]">
            <div className="kicker mb-1 text-warning">// api keys are blocked here</div>
            <p className="text-[13px] text-muted">
              {ws.workspace.name} requires SSO and doesn’t allow API keys, so agents can’t connect.
              An admin can allow them under Settings → Authentication.
            </p>
          </div>
        )}
        <FormRow label="Server URL" hint="One URL per workspace. The transport is Streamable HTTP.">
          <div className="flex gap-2">
            <input className="input font-mono text-[12.5px]" value={url} readOnly />
            <CopyButton text={url} />
          </div>
        </FormRow>
        {!blocked && (
          <p className="text-[11.5px] text-index">
            Admins who require SSO can block API keys; agents then get a 403.
          </p>
        )}
      </SettingsCard>

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

      <SettingsCard title="Set it up yourself" description={active.where}>
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
        <Snippet text={active.snippet(url, name, snippetKey)} />
        {snippetKey === PLACEHOLDER && active.key !== 'vscode' && (
          <p className="mt-2 text-[11.5px] text-index">Replace {PLACEHOLDER} with your key.</p>
        )}
      </SettingsCard>

      <SettingsCard
        title="Or let your agent do it"
        description="Paste this into your coding agent. It adds the server to its own MCP config and checks the connection with a test call."
      >
        {created && (
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
    </>
  );
}
