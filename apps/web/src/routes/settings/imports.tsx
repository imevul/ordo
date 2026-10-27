import type { Import, ImportMapping, ImportSource, ImportStatus } from '@ordo/shared';
import { IMPORT_BUSY } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Play, Plus, Trash2, Undo2, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, upload, wsPath } from '../../api/client.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import { t } from '../../i18n/index.ts';
import { relativeTime } from '../../lib/format.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { CsvColumnsEditor, ImportReportView, MappingEditor } from './import-mapping.tsx';
import { FormRow, SettingsCard } from './ui.tsx';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : t('common.error'));

const SOURCES: ImportSource[] = ['csv', 'linear', 'github', 'gitlab', 'forgejo', 'jira'];
// Product names stay as they are; only the CSV choice is words.
const sourceLabel = (s: ImportSource) =>
  ({
    csv: t('imports.sources.csv'),
    linear: 'Linear',
    github: 'GitHub',
    gitlab: 'GitLab',
    forgejo: 'Forgejo / Gitea',
    jira: 'Jira',
  })[s] ?? s;

const STATUS_COLOR: Record<ImportStatus, string | undefined> = {
  analyzing: 'var(--color-warning)',
  ready: 'var(--color-highlight)',
  dry_running: 'var(--color-warning)',
  running: 'var(--color-warning)',
  completed: 'var(--color-success)',
  failed: 'var(--color-error)',
  canceled: undefined,
  undoing: 'var(--color-warning)',
  undone: undefined,
};

const PHASES = ['setup', 'issues', 'parents', 'relations', 'comments', 'done', 'undo'] as const;
const phaseLabel = (phase: string | undefined) =>
  (PHASES as readonly string[]).includes(phase ?? '')
    ? t(`imports.phase.${phase as (typeof PHASES)[number]}`)
    : t('imports.phase.working');

function StatusChip({ status }: { status: ImportStatus }) {
  const color = STATUS_COLOR[status];
  const label = t(`imports.status.${status}`);
  return color ? (
    <span className="chip" style={{ '--chip': color } as React.CSSProperties}>
      {label}
    </span>
  ) : (
    <span className="tag font-mono">{label}</span>
  );
}

const isBusy = (imp: Import) => IMPORT_BUSY.includes(imp.status);

export function ImportsSection() {
  const ws = useWorkspace();
  const key = ['ws', ws.slug, 'imports'];
  const { data: list } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Import[]>(wsPath(ws.slug, '/imports')),
    enabled: ws.isAdmin,
    // Realtime events refresh it; this covers a missed one while something is running.
    refetchInterval: (q) => (q.state.data?.some(isBusy) ? 4000 : false),
  });
  const [starting, setStarting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  if (!list) return <Spinner />;
  return (
    <SettingsCard title={t('imports.list.title')} description={t('imports.list.description')}>
      {list.map((imp) => (
        <button
          key={imp.id}
          type="button"
          className="flex w-full items-center gap-3 border-b border-border-soft py-3 text-left hover:bg-surface/40"
          onClick={() => setOpen(imp.id)}
        >
          <span className="tag w-24 flex-none justify-center font-mono">
            {sourceLabel(imp.source)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px]">{imp.name}</span>
            <span className="block truncate text-[11.5px] text-index">
              {imp.createdBy?.name ?? t('imports.list.someone')} · {relativeTime(imp.createdAt)}
              {imp.summary && ` · ${t('common.issueCount', { count: imp.summary.counts.issues })}`}
              {imp.error && ` · ${imp.error}`}
            </span>
          </span>
          {isBusy(imp) && imp.progress && (
            <span className="font-mono text-[11px] text-muted">
              {imp.progress.done}/{imp.progress.total}
            </span>
          )}
          <StatusChip status={imp.status} />
        </button>
      ))}
      {list.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('imports.list.empty')}</p>
      )}
      <button type="button" className="btn btn-primary mt-4" onClick={() => setStarting(true)}>
        <Plus size={13} /> {t('imports.list.newImport')}
      </button>
      <StartImportModal
        open={starting}
        onClose={() => setStarting(false)}
        onStarted={(id) => {
          setStarting(false);
          setOpen(id);
        }}
      />
      <ImportModal id={open} onClose={() => setOpen(null)} />
    </SettingsCard>
  );
}

function StartImportModal({
  open,
  onClose,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const [source, setSource] = useState<ImportSource>('csv');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setFields({});
      setFile(null);
    }
  }, [open]);
  const field = (name: string) => ({
    value: fields[name] ?? '',
    onChange: (e: { target: { value: string } }) =>
      setFields({ ...fields, [name]: e.target.value }),
  });
  const list = (name: string) =>
    (fields[name] ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      let started: Import;
      if (source === 'csv') {
        if (!file) throw new Error(t('imports.start.chooseFile'));
        started = await upload<Import>(wsPath(ws.slug, '/imports'), file, file.name);
      } else {
        const optional = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);
        const body =
          source === 'linear'
            ? { source, apiKey: fields.apiKey }
            : source === 'github'
              ? {
                  source,
                  token: fields.token,
                  repos: list('repos'),
                  apiUrl: optional(fields.apiUrl),
                }
              : source === 'forgejo'
                ? { source, baseUrl: fields.baseUrl, token: fields.token, repos: list('repos') }
                : source === 'gitlab'
                  ? {
                      source,
                      baseUrl: optional(fields.baseUrl),
                      token: fields.token,
                      projects: list('projects'),
                    }
                  : {
                      source,
                      siteUrl: fields.siteUrl,
                      email: optional(fields.email),
                      token: fields.token,
                      projects: list('projects').length
                        ? list('projects').map((p) => p.toUpperCase())
                        : undefined,
                    };
        started = await api.post<Import>(wsPath(ws.slug, '/imports'), body);
      }
      qc.invalidateQueries({ queryKey: ['ws', ws.slug, 'imports'] });
      onStarted(started.id);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const token = (label: string, hint?: string) => (
    <FormRow label={label} hint={hint}>
      <input
        className="input font-mono"
        type="password"
        required
        autoComplete="off"
        {...field(source === 'linear' ? 'apiKey' : 'token')}
      />
    </FormRow>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      label={t('imports.start.title')}
      align="center"
    >
      <form className="max-h-[82vh] overflow-y-auto p-6" onSubmit={submit}>
        <div className="section-label mb-4">{t('imports.start.title')}</div>
        <div
          className="mb-5 flex flex-wrap gap-1.5"
          role="radiogroup"
          aria-label={t('imports.start.source')}
        >
          {SOURCES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={source === s}
              className={`btn btn-sm ${source === s ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setSource(s)}
            >
              {sourceLabel(s)}
            </button>
          ))}
        </div>

        {source === 'csv' && (
          <FormRow label={t('imports.start.file')} hint={t('imports.start.fileHint')}>
            <input
              className="input py-1.5"
              type="file"
              accept=".csv,text/csv"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </FormRow>
        )}
        {source === 'linear' &&
          token(t('imports.start.personalApiKey'), t('imports.start.linearKeyHint'))}
        {source === 'github' && (
          <>
            <FormRow
              label={t('imports.start.repositories')}
              hint={t('imports.start.repositoriesHint')}
            >
              <textarea className="input min-h-20 font-mono" required {...field('repos')} />
            </FormRow>
            {token(t('imports.start.token'), t('imports.start.githubTokenHint'))}
            <FormRow
              label={t('imports.start.apiUrl')}
              hint={t('imports.start.apiUrlHint', {
                example: 'https://github.example.com/api/v3',
              })}
            >
              <input
                className="input font-mono"
                type="url"
                placeholder="https://api.github.com"
                {...field('apiUrl')}
              />
            </FormRow>
          </>
        )}
        {source === 'forgejo' && (
          <>
            <FormRow label={t('imports.start.server')}>
              <input
                className="input font-mono"
                type="url"
                required
                placeholder="https://codeberg.org"
                {...field('baseUrl')}
              />
            </FormRow>
            <FormRow
              label={t('imports.start.repositories')}
              hint={t('imports.start.repositoriesHint')}
            >
              <textarea className="input min-h-20 font-mono" required {...field('repos')} />
            </FormRow>
            {token(t('imports.start.accessToken'))}
          </>
        )}
        {source === 'gitlab' && (
          <>
            <FormRow label={t('imports.start.server')}>
              <input
                className="input font-mono"
                type="url"
                placeholder="https://gitlab.com"
                {...field('baseUrl')}
              />
            </FormRow>
            <FormRow
              label={t('imports.start.projects')}
              hint={t('imports.start.gitlabProjectsHint')}
            >
              <textarea className="input min-h-20 font-mono" required {...field('projects')} />
            </FormRow>
            {token(
              t('imports.start.accessToken'),
              t('imports.start.gitlabTokenHint', { scope: 'read_api' }),
            )}
          </>
        )}
        {source === 'jira' && (
          <>
            <FormRow label={t('imports.start.site')}>
              <input
                className="input font-mono"
                type="url"
                required
                placeholder="https://acme.atlassian.net"
                {...field('siteUrl')}
              />
            </FormRow>
            <FormRow label={t('imports.start.email')} hint={t('imports.start.jiraEmailHint')}>
              <input className="input" type="email" {...field('email')} />
            </FormRow>
            {token(t('imports.start.apiToken'))}
            <FormRow
              label={t('imports.start.projects')}
              hint={t('imports.start.jiraProjectsHint', { example: 'ENG' })}
            >
              <input className="input font-mono uppercase" {...field('projects')} />
            </FormRow>
          </>
        )}
        {source !== 'csv' && (
          <p className="mb-2 text-[12px] text-muted">{t('imports.start.credentialsNote')}</p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? t('imports.start.checking') : t('common.continue')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ImportModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'imports', id];
  const { data: imp } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Import>(wsPath(ws.slug, `/imports/${id}`)),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && isBusy(q.state.data) ? 2500 : false),
  });
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  // Fresh from the server when it changes there (a new analysis), unless being edited.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const stamp = imp ? `${imp.id}:${JSON.stringify(imp.mapping)}` : null;
    if (imp?.mapping && stamp !== seen.current && !dirty) {
      setMapping(imp.mapping);
      seen.current = stamp;
    }
  }, [imp, dirty]);
  useEffect(() => {
    if (!id) {
      setDirty(false);
      seen.current = null;
    }
  }, [id]);

  const reload = () => qc.invalidateQueries({ queryKey: ['ws', ws.slug, 'imports'] });
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const saveMapping = async () => {
    if (!dirty || !mapping) return;
    await api.patch(wsPath(ws.slug, `/imports/${id}`), { mapping });
    setDirty(false);
  };
  const start = (kind: 'dry-run' | 'run') =>
    act(async () => {
      await saveMapping();
      await api.post(wsPath(ws.slug, `/imports/${id}/${kind}`));
    });

  return (
    <Modal
      open={!!id}
      onClose={onClose}
      width={860}
      label={t('imports.detail.label')}
      align="center"
    >
      {!imp ? (
        <Spinner />
      ) : (
        <div className="max-h-[86vh] overflow-y-auto p-6">
          <div className="mb-1 flex items-center gap-3">
            <div className="section-label min-w-0 flex-1 truncate">{imp.name}</div>
            <StatusChip status={imp.status} />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t('common.close')}
              onClick={onClose}
            >
              <X size={13} />
            </button>
          </div>
          <p className="mb-5 text-[12px] text-index">
            {sourceLabel(imp.source)} ·{' '}
            {t('imports.detail.startedBy', {
              name: imp.createdBy?.name ?? t('imports.detail.someone'),
              time: relativeTime(imp.createdAt),
            })}
            {imp.summary &&
              ` · ${t('common.issueCount', { count: imp.summary.counts.issues })}${imp.summary.counts.comments ? `, ${t('imports.detail.commentCount', { count: imp.summary.counts.comments })}` : ''}`}
          </p>

          {imp.error && (
            <p
              className={`mb-5 border px-3 py-2 text-[12.5px] ${imp.status === 'failed' ? 'border-error/40 text-error' : 'border-warning/40 text-warning'}`}
            >
              {imp.error}
            </p>
          )}

          {isBusy(imp) && (
            <div className="mb-6">
              <div className="mb-1 flex items-center gap-2 text-[12.5px]">
                <span className="flex-1 text-muted">
                  {imp.status === 'analyzing'
                    ? t('imports.phase.analyzing')
                    : phaseLabel(imp.progress?.phase)}
                </span>
                {imp.progress && imp.status !== 'analyzing' && (
                  <span className="font-mono text-[11px] text-index">
                    {imp.progress.done}
                    {imp.progress.total ? ` / ${imp.progress.total}` : ''}
                  </span>
                )}
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{
                    width: `${imp.progress?.total ? Math.min(100, Math.round((imp.progress.done / imp.progress.total) * 100)) : 0}%`,
                  }}
                />
              </div>
              {imp.status !== 'analyzing' && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm mt-3"
                  disabled={busy || imp.status === 'undoing'}
                  onClick={() => act(() => api.post(wsPath(ws.slug, `/imports/${imp.id}/cancel`)))}
                >
                  <X size={12} /> {t('common.cancel')}
                </button>
              )}
            </div>
          )}

          {imp.report && !isBusy(imp) && <ImportReportView report={imp.report} />}

          {imp.summary && ['ready', 'failed', 'canceled'].includes(imp.status) && (
            <>
              {imp.summary.warnings.map((w) => (
                <p key={w} className="mb-3 text-[12.5px] text-warning">
                  {w}
                </p>
              ))}
              {imp.summary.csv && (
                <CsvColumnsEditor
                  imp={imp}
                  onApply={(columns) =>
                    act(async () => {
                      setDirty(false);
                      await api.patch(wsPath(ws.slug, `/imports/${imp.id}`), {
                        config: { columns },
                      });
                    })
                  }
                />
              )}
              {mapping && (
                <MappingEditor
                  imp={imp}
                  mapping={mapping}
                  onChange={(m) => {
                    setMapping(m);
                    setDirty(true);
                  }}
                />
              )}
              <div className="mt-6 flex flex-wrap justify-end gap-2">
                {dirty && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => act(saveMapping)}
                  >
                    {t('imports.detail.saveMapping')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => start('dry-run')}
                >
                  <FlaskConical size={13} /> {t('imports.detail.dryRun')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !(await confirmDialog({
                        title: t('imports.detail.confirmImportTitle', {
                          count: imp.summary!.counts.issues,
                        }),
                        body: t('imports.detail.confirmImportBody'),
                        confirmLabel: t('imports.detail.import'),
                      }))
                    )
                      return;
                    await start('run');
                  }}
                >
                  <Play size={13} /> {t('imports.detail.import')}
                </button>
              </div>
            </>
          )}

          {!isBusy(imp) && (
            <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-border-soft pt-4">
              {['completed', 'failed', 'canceled'].includes(imp.status) &&
                imp.report &&
                !imp.report.dryRun && (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        !(await confirmDialog({
                          title: t('imports.detail.confirmUndoTitle'),
                          body: t('imports.detail.confirmUndoBody'),
                          confirmLabel: t('imports.detail.undoImport'),
                          danger: true,
                        }))
                      )
                        return;
                      await act(() => api.post(wsPath(ws.slug, `/imports/${imp.id}/undo`)));
                    }}
                  >
                    <Undo2 size={12} /> {t('imports.detail.undoImport')}
                  </button>
                )}
              <span className="flex-1" />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={async () => {
                  if (
                    !(await confirmDialog({
                      title: t('imports.detail.confirmForgetTitle'),
                      body: t('imports.detail.confirmForgetBody'),
                      confirmLabel: t('imports.detail.confirmForget'),
                      danger: true,
                    }))
                  )
                    return;
                  await act(() => api.del(wsPath(ws.slug, `/imports/${imp.id}`)));
                  onClose();
                }}
              >
                <Trash2 size={12} /> {t('imports.detail.forget')}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
