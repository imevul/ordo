import type { Integration, IntegrationProviderInfo } from '@ordo/shared';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { t } from '../../i18n/index.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FormRow, TeamSelect } from './ui.tsx';

type Mode = 'links' | 'mirror' | 'sync';

interface ProjectRow {
  key: string;
  teamId: string;
  issueType: string;
  createInOrdo: boolean;
  createInJira: boolean;
}

/** Connects (or edits) Jira: credentials, what it does (links, mirror, two-way sync) and which projects. */
export function JiraForm({
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
  const c = (existing?.config ?? {}) as {
    siteUrl?: string;
    mode?: Mode;
    delivery?: string;
    backlinks?: boolean;
    projects?: Partial<ProjectRow>[];
  };
  const firstTeam = ws.teams[0]?.id ?? '';
  const [v, setV] = useState({
    siteUrl: c.siteUrl ?? '',
    email: '',
    token: '',
    webhookSecret: '',
    mode: c.mode ?? 'links',
    delivery: c.delivery ?? 'webhook',
    backlinks: c.backlinks !== false,
  });
  const [projects, setProjects] = useState<ProjectRow[]>(
    (c.projects ?? []).map((p) => ({
      key: p.key ?? '',
      teamId: p.teamId ?? firstTeam,
      issueType: p.issueType ?? 'Task',
      createInOrdo: p.createInOrdo !== false,
      createInJira: p.createInJira === true,
    })),
  );
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  const setProject = (i: number, patch: Partial<ProjectRow>) =>
    setProjects((list) => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const synced = v.mode !== 'links';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const config = {
      siteUrl: v.siteUrl,
      mode: v.mode,
      delivery: v.delivery,
      backlinks: v.backlinks,
      projects: projects
        .filter((p) => p.key.trim())
        .map((p) => ({ ...p, key: p.key.trim().toUpperCase(), teamId: synced ? p.teamId : null })),
    };
    const secrets = {
      token: v.token,
      ...(v.email && { email: v.email }),
      ...(v.webhookSecret && { webhookSecret: v.webhookSecret }),
    };
    try {
      const res = existing
        ? await api.patch<Integration>(wsPath(ws.slug, `/integrations/${existing.id}`), {
            config,
            secrets,
          })
        : await api.post<Integration>(wsPath(ws.slug, '/integrations'), {
            provider: provider.key,
            config,
            secrets,
          });
      if (res.status === 'error')
        toast.error(t('integrations.form.savedButError', { error: res.lastError ?? '' }));
      else toast.success(existing ? t('common.saved') : t('integrations.jira.connected'));
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const radio = (
    name: string,
    options: [string, string, string][],
    value: string,
    onChange: (v: string) => void,
  ) => (
    <div className="mb-4 flex flex-col gap-2 text-[13px]">
      {options.map(([key, label, hint]) => (
        <label key={key} className="flex items-start gap-2">
          <input
            type="radio"
            name={name}
            className="mt-1 accent-primary"
            checked={value === key}
            onChange={() => onChange(key)}
          />
          <span>
            {label}
            <span className="block text-[12px] text-index">{hint}</span>
          </span>
        </label>
      ))}
    </div>
  );

  return (
    <form onSubmit={submit}>
      <p className="mb-4 text-[12.5px] text-muted">{t('integrations.jira.intro')}</p>
      <FormRow label={t('integrations.jira.siteUrl')}>
        <input
          className="input font-mono"
          required
          placeholder="https://acme.atlassian.net"
          value={v.siteUrl}
          onChange={(e) => set({ siteUrl: e.target.value })}
        />
      </FormRow>
      <FormRow
        label={t('integrations.jira.email')}
        hint={existing ? t('integrations.form.keepSecret') : t('integrations.jira.emailHint')}
      >
        <input
          className="input font-mono"
          type="email"
          autoComplete="off"
          value={v.email}
          onChange={(e) => set({ email: e.target.value })}
        />
      </FormRow>
      <FormRow
        label={t('integrations.jira.token')}
        hint={existing ? t('integrations.form.keepSecret') : undefined}
      >
        <input
          className="input font-mono"
          type="password"
          autoComplete="off"
          required={!existing}
          value={v.token}
          onChange={(e) => set({ token: e.target.value })}
        />
      </FormRow>

      <div className="mb-1 text-[12px] text-muted">{t('integrations.jira.modeTitle')}</div>
      {radio(
        'jira-mode',
        [
          ['links', t('integrations.jira.modes.links'), t('integrations.jira.modes.linksHint')],
          ['mirror', t('integrations.jira.modes.mirror'), t('integrations.jira.modes.mirrorHint')],
          ['sync', t('integrations.jira.modes.sync'), t('integrations.jira.modes.syncHint')],
        ],
        v.mode,
        (mode) => set({ mode: mode as Mode }),
      )}

      <div className="mb-1 text-[12px] text-muted">{t('integrations.jira.projects')}</div>
      <p className="mb-2 text-[11.5px] text-index">
        {synced
          ? t('integrations.jira.projectsHintSync')
          : t('integrations.jira.projectsHintLinks')}
      </p>
      {projects.map((p, i) => (
        <div key={i} className="mb-2 border border-border-soft bg-bg p-3">
          <div className="flex gap-2">
            <input
              className="input w-28 font-mono uppercase"
              placeholder="PROJ"
              aria-label={t('integrations.jira.projectKey')}
              required
              value={p.key}
              onChange={(e) => setProject(i, { key: e.target.value })}
            />
            {synced && (
              <TeamSelect
                className="input flex-1"
                aria-label={t('integrations.jira.team')}
                value={p.teamId}
                onChange={(teamId) => setProject(i, { teamId })}
              />
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm ml-auto"
              aria-label={t('integrations.jira.removeProject')}
              onClick={() => setProjects((list) => list.filter((_, j) => j !== i))}
            >
              <Trash2 size={12} />
            </button>
          </div>
          {synced && (
            <div className="mt-2 flex flex-col gap-1 text-[12.5px]">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={p.createInOrdo}
                  onChange={(e) => setProject(i, { createInOrdo: e.target.checked })}
                />
                {t('integrations.jira.createInOrdo')}
              </label>
              {v.mode === 'sync' && (
                <>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={p.createInJira}
                      onChange={(e) => setProject(i, { createInJira: e.target.checked })}
                    />
                    {t('integrations.jira.createInJira')}
                  </label>
                  {p.createInJira && (
                    <label className="flex items-center gap-2 text-muted">
                      {t('integrations.jira.issueType')}
                      <input
                        className="input h-7 w-32 py-0 text-[12px]"
                        title={t('integrations.jira.issueTypeHint')}
                        value={p.issueType}
                        onChange={(e) => setProject(i, { issueType: e.target.value })}
                      />
                    </label>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        className="btn btn-ghost btn-sm mb-4"
        onClick={() =>
          setProjects((list) => [
            ...list,
            {
              key: '',
              teamId: firstTeam,
              issueType: 'Task',
              createInOrdo: true,
              createInJira: false,
            },
          ])
        }
      >
        <Plus size={12} /> {t('integrations.jira.addProject')}
      </button>

      <label className="mb-4 flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          className="accent-primary"
          checked={v.backlinks}
          onChange={(e) => set({ backlinks: e.target.checked })}
        />
        {t('integrations.jira.backlinks')}
      </label>

      <div className="mb-1 text-[12px] text-muted">{t('integrations.jira.deliveryTitle')}</div>
      {radio(
        'jira-delivery',
        [
          ['webhook', t('integrations.jira.webhook'), t('integrations.jira.webhookHint')],
          ['poll', t('integrations.jira.poll'), t('integrations.jira.pollHint')],
        ],
        v.delivery,
        (delivery) => set({ delivery }),
      )}
      {v.delivery === 'webhook' && (
        <FormRow
          label={t('integrations.jira.webhookSecret')}
          hint={t('integrations.jira.webhookSecretHint')}
        >
          <input
            className="input font-mono"
            type="password"
            autoComplete="off"
            value={v.webhookSecret}
            onChange={(e) => set({ webhookSecret: e.target.value })}
          />
        </FormRow>
      )}

      <div className="mt-6 flex justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {existing ? t('common.save') : t('integrations.list.connect')}
        </button>
      </div>
    </form>
  );
}
