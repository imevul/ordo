import type {
  Agent,
  ForgeRepository,
  Integration,
  IntegrationProviderInfo,
  Repository,
} from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Pencil, Plus, Power, Search, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { keys as queryKeys } from '../../api/queries.ts';
import { TeamIcon } from '../../components/icons.tsx';
import { MarkdownEditor } from '../../components/MarkdownEditor.tsx';
import { Spinner } from '../../components/PageHeader.tsx';
import { Avatar } from '../../components/ui/Avatar.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import { t, tx } from '../../i18n/index.ts';
import { relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

const copy = (text: string) => {
  navigator.clipboard.writeText(text);
  toast.success(t('common.copied'));
};

const toggle = <T,>(list: T[], v: T) =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

/** Settings → Agents: who they are, which teams they work in, and the keys their runners use. */
export function AgentsSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'agents'];
  const { data: agents } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Agent[]>(wsPath(ws.slug, '/agents')),
    enabled: ws.isAdmin,
  });
  const [editing, setEditing] = useState<Agent | 'new' | null>(null);
  const [keyFor, setKeyFor] = useState<Agent | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const reload = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: queryKeys.bootstrap(ws.slug) });
  };

  if (!ws.isAdmin) return <p className="text-muted">{t('agents.adminsOnly')}</p>;
  if (!agents) return <Spinner />;

  return (
    <>
      <SettingsCard
        title={t('agents.title')}
        description={tx('agents.description', {
          command: <code className="font-mono text-text">ordo agent run</code>,
        })}
      >
        {agents.map((a) => (
          <div key={a.id} className="border-b border-border-soft py-3">
            <div className="flex items-center gap-3">
              <Avatar name={a.name} color={a.avatarColor} size={22} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13.5px]">
                  <span className={a.disabled ? 'text-index line-through' : ''}>{a.name}</span>
                  <span className="font-mono text-[11.5px] text-index">@{a.username}</span>
                  {a.disabled && <span className="tag font-mono">{t('agents.disabled')}</span>}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-index">
                  {a.teamIds.length === 0 && t('agents.noTeams')}
                  {a.teamIds.map((id) => {
                    const team = ws.teamById.get(id);
                    return team ? (
                      <span key={id} className="inline-flex items-center gap-1">
                        <TeamIcon color={team.color} label={team.key} size={12} /> {team.key}
                      </span>
                    ) : null;
                  })}
                  <span>· {t('agents.keyCount', { count: a.keys.length })}</span>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={a.disabled}
                onClick={() => setKeyFor(a)}
              >
                <KeyRound size={12} /> {t('agents.newKey')}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t('agents.edit', { name: a.name })}
                onClick={() => setEditing(a)}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className={`btn btn-sm ${a.disabled ? 'btn-ghost' : 'btn-danger'}`}
                title={a.disabled ? t('agents.enable') : t('agents.disable')}
                aria-label={a.disabled ? t('agents.enable') : t('agents.disable')}
                onClick={async () => {
                  if (
                    !a.disabled &&
                    !(await confirmDialog({
                      title: t('agents.confirmDisable', { name: a.name }),
                      danger: true,
                    }))
                  )
                    return;
                  try {
                    await api.patch(wsPath(ws.slug, `/agents/${a.id}`), { disabled: !a.disabled });
                    reload();
                  } catch (err) {
                    toast.error(errMsg(err));
                  }
                }}
              >
                <Power size={12} />
              </button>
            </div>
            {a.keys.length > 0 && (
              <div className="mt-2 ml-[34px]">
                {a.keys.map((k) => (
                  <div key={k.id} className="flex items-center gap-2 py-0.5 text-[12px]">
                    <KeyRound size={11} className="flex-none text-index" />
                    <span className="min-w-0 flex-1 truncate">
                      {k.name}{' '}
                      <span className="font-mono text-index">
                        {k.lastUsedAt
                          ? t('agents.keys.used', {
                              prefix: k.prefix,
                              time: relativeTime(k.lastUsedAt),
                            })
                          : t('agents.keys.unused', { prefix: k.prefix })}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        if (
                          !(await confirmDialog({
                            title: t('agents.keys.confirmRevoke', { name: k.name }),
                            danger: true,
                          }))
                        )
                          return;
                        await api.del(wsPath(ws.slug, `/agents/${a.id}/keys/${k.id}`));
                        reload();
                      }}
                    >
                      {t('agents.keys.revoke')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {agents.length === 0 && (
          <p className="font-mono text-[12px] text-index">{t('agents.empty')}</p>
        )}
        <button type="button" className="btn btn-primary mt-4" onClick={() => setEditing('new')}>
          <Plus size={13} /> {t('agents.add')}
        </button>
      </SettingsCard>

      <AgentModal
        agent={editing}
        onClose={() => setEditing(null)}
        onSaved={(created) => {
          setEditing(null);
          reload();
          // A new agent needs a key before anything can run for it.
          if (created) setKeyFor(created);
        }}
      />
      <KeyModal
        agent={keyFor}
        onClose={() => setKeyFor(null)}
        onCreated={(value) => {
          setKeyFor(null);
          setToken(value);
          reload();
        }}
      />
      <TokenModal token={token} onClose={() => setToken(null)} />
    </>
  );
}

function AgentModal({
  agent,
  onClose,
  onSaved,
}: {
  agent: Agent | 'new' | null;
  onClose: () => void;
  onSaved: (created?: Agent) => void;
}) {
  const ws = useWorkspace();
  const existing = agent && agent !== 'new' ? agent : null;
  const [name, setName] = useState('');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [instructions, setInstructions] = useState('');
  const [concurrency, setConcurrency] = useState(1);
  const [followPullRequests, setFollowPullRequests] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!agent) return;
    setName(existing?.name ?? '');
    setTeamIds(existing?.teamIds ?? (ws.teams[0] ? [ws.teams[0].id] : []));
    setInstructions(existing?.instructions ?? '');
    setConcurrency(existing?.concurrency ?? 1);
    setFollowPullRequests(existing?.followPullRequests ?? true);
  }, [agent, existing, ws.teams]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (teamIds.length === 0) {
      toast.error(t('agents.form.pickTeam'));
      return;
    }
    setBusy(true);
    const body = { name, teamIds, instructions, concurrency, followPullRequests };
    try {
      if (existing) {
        await api.patch(wsPath(ws.slug, `/agents/${existing.id}`), body);
        onSaved();
      } else onSaved(await api.post<Agent>(wsPath(ws.slug, '/agents'), body));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!agent}
      onClose={onClose}
      width={620}
      label={t('agents.form.label')}
      align="center"
    >
      <form className="max-h-[82vh] overflow-y-auto p-6" onSubmit={submit}>
        <div className="section-label mb-4">
          {existing ? t('agents.form.edit') : t('agents.form.new')}
        </div>
        <FormRow label={t('agents.form.name')}>
          <input
            className="input"
            required
            autoFocus
            maxLength={120}
            placeholder={t('agents.form.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </FormRow>
        <div className="mb-1 text-[12px] text-muted">{t('agents.form.teams')}</div>
        <div className="mb-1 flex flex-wrap gap-3 border border-border-soft p-3">
          {ws.teams.map((team) => (
            <label key={team.id} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="accent-primary"
                checked={teamIds.includes(team.id)}
                onChange={() => setTeamIds(toggle(teamIds, team.id))}
              />
              <TeamIcon color={team.color} label={team.key} size={14} /> {team.name}
            </label>
          ))}
        </div>
        <p className="mb-4 text-[11.5px] text-index">{t('agents.form.teamsHint')}</p>
        <div className="mb-1 text-[12px] text-muted">{t('agents.form.instructions')}</div>
        <MarkdownEditor
          value={instructions}
          onChange={setInstructions}
          minRows={5}
          placeholder={t('agents.form.instructionsPlaceholder')}
        />
        <p className="mt-1 mb-4 text-[11.5px] text-index">{t('agents.form.instructionsHint')}</p>
        <FormRow label={t('agents.form.concurrency')} hint={t('agents.form.concurrencyHint')}>
          <input
            className="input w-24"
            type="number"
            min={1}
            max={20}
            value={concurrency}
            onChange={(e) => setConcurrency(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
          />
        </FormRow>
        <label className="mt-4 flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={followPullRequests}
            onChange={(e) => setFollowPullRequests(e.target.checked)}
          />
          <span>
            {t('agents.form.followPullRequests')}
            <span className="block text-[11.5px] text-index">
              {t('agents.form.followPullRequestsHint')}
            </span>
          </span>
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {existing ? t('common.save') : t('agents.add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function KeyModal({
  agent,
  onClose,
  onCreated,
}: {
  agent: Agent | null;
  onClose: () => void;
  onCreated: (token: string) => void;
}) {
  const ws = useWorkspace();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (agent) setName('');
  }, [agent]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!agent) return;
    setBusy(true);
    try {
      const res = await api.post<{ token: string }>(wsPath(ws.slug, `/agents/${agent.id}/keys`), {
        name,
      });
      onCreated(res.token);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={!!agent} onClose={onClose} width={480} label={t('agents.newKey')} align="center">
      <form className="p-6" onSubmit={submit}>
        <div className="section-label mb-4">
          {t('agents.newKey')} · {agent?.name}
        </div>
        <FormRow label={t('agents.keys.name')}>
          <input
            className="input"
            required
            autoFocus
            maxLength={120}
            placeholder={t('agents.keys.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </FormRow>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {t('agents.keys.create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TokenModal({ token, onClose }: { token: string | null; onClose: () => void }) {
  const ws = useWorkspace();
  const origin = location.origin;
  const command = `ordo agent run --url ${origin} -w ${ws.slug} --key ${token} -- claude -p`;
  const file = `# agents.yaml — ordo agent run --file agents.yaml\nurl: ${origin}\nworkspace: ${ws.slug}\nkey: \${AGENT_KEY}   # AGENT_KEY=… in .env\ncommand: [claude, -p]`;
  return (
    <Modal
      open={!!token}
      onClose={onClose}
      width={640}
      label={t('agents.token.title')}
      align="center"
    >
      <div className="p-6">
        <div className="section-label mb-4">{t('agents.token.title')}</div>
        <div className="mb-4 flex items-center gap-2 border border-border-soft bg-bg p-3">
          <code className="flex-1 truncate font-mono text-[12.5px]">{token}</code>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(token!)}>
            <Copy size={12} /> {t('common.copy')}
          </button>
        </div>
        <p className="mb-2 text-[13px] text-muted">{t('agents.token.body')}</p>
        <Snippet text={command} />
        <p className="mt-4 mb-2 text-[13px] text-muted">{t('agents.token.fileHint')}</p>
        <Snippet text={file} />
        <div className="mt-6 flex justify-end">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Snippet({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto border border-border-soft bg-bg p-3 pr-12 font-mono text-[11.5px] whitespace-pre">
        {text}
      </pre>
      <button
        type="button"
        className="btn btn-ghost btn-sm absolute top-1.5 right-1.5"
        aria-label={t('common.copy')}
        onClick={() => copy(text)}
      >
        <Copy size={12} />
      </button>
    </div>
  );
}

// ─── Repositories ────────────────────────────────────────────────────

/** Forge providers whose integrations can list the repositories they see. */
const BROWSABLE = new Set(['github', 'forgejo']);

/** What picking a forge repository fills into the new-repository form. */
interface RepositoryDraft {
  name: string;
  url: string;
  defaultBranch: string;
  integrationId: string;
  externalRepo: string;
}

/** Settings → Repositories: where code lives, for projects and team defaults to point at. */
export function RepositoriesSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Repository | 'new' | null>(null);
  const [draft, setDraft] = useState<RepositoryDraft | undefined>();
  const [browsing, setBrowsing] = useState(false);
  const { data: connected } = useQuery({
    queryKey: ['ws', ws.slug, 'integrations'],
    queryFn: () =>
      api.get<{ providers: IntegrationProviderInfo[]; integrations: Integration[] }>(
        wsPath(ws.slug, '/integrations'),
      ),
    enabled: ws.isAdmin,
  });
  const forges = (connected?.integrations ?? []).filter(
    (i) => BROWSABLE.has(i.provider) && i.status !== 'disabled',
  );
  const reload = () => qc.invalidateQueries({ queryKey: queryKeys.bootstrap(ws.slug) });
  if (!ws.isAdmin) return <p className="text-muted">{t('agents.repositories.adminsOnly')}</p>;
  return (
    <>
      <SettingsCard
        title={t('agents.repositories.title')}
        description={t('agents.repositories.description')}
      >
        {ws.repositories.map((r) => (
          <div key={r.id} className="flex items-center gap-3 border-b border-border-soft py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px]">{r.name}</div>
              <div className="truncate font-mono text-[11.5px] text-index">
                {r.url} · {t('agents.repositories.branch', { branch: r.defaultBranch })}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t('agents.repositories.edit', { name: r.name })}
              onClick={() => setEditing(r)}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              aria-label={t('agents.repositories.delete', { name: r.name })}
              onClick={async () => {
                if (
                  !(await confirmDialog({
                    title: t('agents.repositories.confirmDelete', { name: r.name }),
                    danger: true,
                  }))
                )
                  return;
                await api.del(wsPath(ws.slug, `/repositories/${r.id}`));
                reload();
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {ws.repositories.length === 0 && (
          <p className="font-mono text-[12px] text-index">{t('agents.repositories.empty')}</p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setDraft(undefined);
              setEditing('new');
            }}
          >
            <Plus size={13} /> {t('agents.repositories.add')}
          </button>
          {forges.length > 0 && (
            <button type="button" className="btn btn-ghost" onClick={() => setBrowsing(true)}>
              <Search size={13} /> {t('agents.repositories.browse')}
            </button>
          )}
        </div>
      </SettingsCard>
      {/* Mounted only while open, so each visit starts fresh. */}
      {browsing && (
        <BrowseRepositoriesModal
          forges={forges}
          onClose={() => setBrowsing(false)}
          onPick={(picked) => {
            setBrowsing(false);
            setDraft(picked);
            setEditing('new');
          }}
        />
      )}
      <RepositoryModal
        repository={editing}
        draft={draft}
        forges={forges}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    </>
  );
}

/** Repositories already added use one URL style; offer the same for new ones. */
function preferredUrlStyle(repositories: Repository[]): 'ssh' | 'https' {
  const https = repositories.filter((r) => /^https?:\/\//.test(r.url)).length;
  return https > repositories.length - https ? 'https' : 'ssh';
}

/** Pick a connected forge, then one of the repositories it can see. */
function BrowseRepositoriesModal({
  forges,
  onClose,
  onPick,
}: {
  forges: Integration[];
  onClose: () => void;
  onPick: (draft: RepositoryDraft) => void;
}) {
  const ws = useWorkspace();
  const [integrationId, setIntegrationId] = useState(forges[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [style, setStyle] = useState(() => preferredUrlStyle(ws.repositories));
  const {
    data: repos,
    error,
    isFetching,
  } = useQuery({
    queryKey: ['ws', ws.slug, 'integrations', integrationId, 'repositories'],
    queryFn: () =>
      api.get<ForgeRepository[]>(wsPath(ws.slug, `/integrations/${integrationId}/repositories`)),
    enabled: !!integrationId,
    staleTime: 60_000,
    retry: false,
  });
  const needle = query.trim().toLowerCase();
  const matches = (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(needle));
  const added = new Set(
    ws.repositories.flatMap((r) => [
      r.url,
      ...(r.integrationId && r.externalRepo ? [`${r.integrationId}:${r.externalRepo}`] : []),
    ]),
  );
  const isAdded = (r: ForgeRepository) =>
    added.has(r.sshUrl) || added.has(r.cloneUrl) || added.has(`${integrationId}:${r.fullName}`);
  const pick = (r: ForgeRepository) =>
    onPick({
      name: r.fullName.split('/').at(-1) ?? r.fullName,
      url: style === 'ssh' ? r.sshUrl : r.cloneUrl,
      defaultBranch: r.defaultBranch,
      integrationId,
      externalRepo: r.fullName,
    });

  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      label={t('agents.repositories.picker.label')}
      align="center"
    >
      <div className="flex min-h-0 flex-col p-6">
        <div className="section-label mb-4">{t('agents.repositories.picker.label')}</div>
        {forges.length > 1 && (
          <FormRow label={t('agents.repositories.picker.integration')}>
            <select
              className="input"
              value={integrationId}
              onChange={(e) => setIntegrationId(e.target.value)}
            >
              {forges.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </FormRow>
        )}
        <div className="mb-3 flex items-center gap-3">
          <input
            className="input flex-1"
            autoFocus
            placeholder={t('agents.repositories.picker.search')}
            aria-label={t('agents.repositories.picker.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              // Same rule as clicking: repositories already added can't be picked again.
              const first = matches.find((r) => !isAdded(r));
              if (first) pick(first);
            }}
          />
          <fieldset className="flex items-center gap-3 text-[12px] text-muted">
            <legend className="sr-only">{t('agents.repositories.picker.cloneWith')}</legend>
            {(['ssh', 'https'] as const).map((s) => (
              <label key={s} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  className="accent-primary"
                  name="clone-style"
                  checked={style === s}
                  onChange={() => setStyle(s)}
                />
                {s === 'ssh' ? 'SSH' : 'HTTPS'}
              </label>
            ))}
          </fieldset>
        </div>
        <div className="min-h-[8rem] flex-1 overflow-y-auto border border-border-soft">
          {error ? (
            <p className="p-3 text-[12.5px] text-error">{errMsg(error)}</p>
          ) : !repos && isFetching ? (
            <div className="p-3">
              <Spinner />
            </div>
          ) : matches.length === 0 ? (
            <p className="p-3 font-mono text-[12px] text-index">
              {t('agents.repositories.picker.empty')}
            </p>
          ) : (
            matches.map((r) => (
              <button
                key={r.fullName}
                type="button"
                className="menu-item disabled:cursor-default disabled:opacity-50"
                disabled={isAdded(r)}
                onClick={() => pick(r)}
              >
                <span className="min-w-0 flex-1 truncate text-left font-mono text-[12.5px]">
                  {r.fullName}
                </span>
                {r.private && (
                  <span className="tag">{t('agents.repositories.picker.private')}</span>
                )}
                {isAdded(r) && (
                  <span className="tag font-mono">{t('agents.repositories.picker.added')}</span>
                )}
              </button>
            ))
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RepositoryModal({
  repository,
  draft,
  forges,
  onClose,
  onSaved,
}: {
  repository: Repository | 'new' | null;
  /** Filled in from a forge repository picked in the browser. */
  draft?: RepositoryDraft;
  forges: Integration[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const ws = useWorkspace();
  const existing = repository && repository !== 'new' ? repository : null;
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!repository) return;
    setName(existing?.name ?? draft?.name ?? '');
    setUrl(existing?.url ?? draft?.url ?? '');
    setDefaultBranch(existing?.defaultBranch ?? draft?.defaultBranch ?? 'main');
  }, [repository, existing, draft]);
  const link = existing ?? (repository === 'new' ? draft : undefined);
  const linkedTo = link?.integrationId
    ? forges.find((f) => f.id === link.integrationId)?.name
    : undefined;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const body = {
      name,
      url,
      defaultBranch,
      ...(!existing &&
        draft && { integrationId: draft.integrationId, externalRepo: draft.externalRepo }),
    };
    try {
      if (existing) await api.patch(wsPath(ws.slug, `/repositories/${existing.id}`), body);
      else await api.post(wsPath(ws.slug, '/repositories'), body);
      onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!repository}
      onClose={onClose}
      width={560}
      label={t('agents.repositories.form.label')}
      align="center"
    >
      <form className="p-6" onSubmit={submit}>
        <div className="section-label mb-4">
          {existing ? t('agents.repositories.form.edit') : t('agents.repositories.form.new')}
        </div>
        <FormRow label={t('agents.repositories.form.name')}>
          <input
            className="input"
            required
            autoFocus
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </FormRow>
        <FormRow
          label={t('agents.repositories.form.url')}
          hint={t('agents.repositories.form.urlHint')}
        >
          <input
            className="input font-mono"
            required
            placeholder="git@git.example.com:acme/app.git"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              // Suggest a name from the URL until one is typed.
              const guess = /([^/:]+?)(\.git)?\/?$/.exec(e.target.value.trim())?.[1];
              if (!existing && guess && (!name || url.includes(name))) setName(guess);
            }}
          />
        </FormRow>
        <FormRow label={t('agents.repositories.form.defaultBranch')}>
          <input
            className="input w-48 font-mono"
            required
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
          />
        </FormRow>
        {link?.externalRepo && linkedTo && (
          <p className="text-[11.5px] text-index">
            {t('agents.repositories.form.linked', {
              repo: link.externalRepo,
              integration: linkedTo,
            })}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {existing ? t('common.save') : t('agents.repositories.add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
