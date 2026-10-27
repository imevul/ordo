import {
  CSV_FIELDS,
  type CsvColumns,
  type CsvField,
  type Import,
  type ImportMapping,
  type ImportReport,
  type ImportTeamTarget,
  STATE_TYPES,
} from '@ordo/shared';
import { useEffect, useState } from 'react';
import { t } from '../../i18n/index.ts';
import { stateTypeLabel } from '../../i18n/labels.ts';
import { useWorkspace } from '../../lib/workspace.tsx';

/**
 * The parts of an import's page that describe and change what goes where: CSV columns, the
 * mapping, and the report of a (dry) run.
 */

const fieldLabel = (field: CsvField) => t(`imports.fields.${field}`);

function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="mb-1 font-mono text-[10.5px] font-semibold tracking-[0.16em] text-index uppercase">
        {title}
      </div>
      {hint && <p className="mb-2 text-[12px] text-muted">{hint}</p>}
      <div className="border border-border-soft">{children}</div>
    </div>
  );
}

function Row({
  left,
  count,
  children,
}: {
  left: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-border-soft/60 px-3 py-1.5 last:border-0">
      <div className="min-w-0 flex-1 truncate text-[13px]">{left}</div>
      {count !== undefined && count > 0 && (
        <span className="font-mono text-[11px] text-index">{count}</span>
      )}
      <div className="w-56 flex-none">{children}</div>
    </div>
  );
}

const select = 'input h-8 w-full py-0 text-[12.5px]';

export function CsvColumnsEditor({
  imp,
  onApply,
}: {
  imp: Import;
  onApply: (columns: CsvColumns) => void;
}) {
  const csv = imp.summary!.csv!;
  const [columns, setColumns] = useState<CsvColumns>(csv.columns);
  useEffect(() => setColumns(csv.columns), [csv.columns]);
  const changed = JSON.stringify(columns) !== JSON.stringify(csv.columns);
  return (
    <Group title={t('imports.columns.title')} hint={t('imports.columns.hint')}>
      <div className="grid grid-cols-1 gap-x-6 px-3 py-2 sm:grid-cols-2">
        {CSV_FIELDS.map((field) => (
          <label key={field} className="flex items-center gap-2 py-1 text-[12.5px]">
            <span className="w-24 flex-none text-muted">{fieldLabel(field)}</span>
            <select
              className={select}
              value={columns[field] ?? ''}
              onChange={(e) => setColumns({ ...columns, [field]: e.target.value || null })}
            >
              <option value="">—</option>
              {csv.headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {changed && (
        <div className="flex justify-end border-t border-border-soft p-2">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onApply(columns)}>
            {t('imports.columns.readAgain')}
          </button>
        </div>
      )}
    </Group>
  );
}

const teamValue = (target: ImportTeamTarget | undefined) =>
  !target
    ? ''
    : 'skip' in target
      ? 'skip'
      : 'create' in target
        ? 'create'
        : `team:${target.teamId}`;

/** Where everything goes. Edits stay local until `onChange` hands them up for saving. */
export function MappingEditor({
  imp,
  mapping,
  onChange,
}: {
  imp: Import;
  mapping: ImportMapping;
  onChange: (m: ImportMapping) => void;
}) {
  const ws = useWorkspace();
  const summary = imp.summary!;
  const set = <K extends keyof ImportMapping>(key: K, value: ImportMapping[K]) =>
    onChange({ ...mapping, [key]: value });
  const workspaceLabels = ws.labels.filter((l) => !l.teamId);
  const people = [...summary.users].sort((a, b) => b.count - a.count);

  return (
    <>
      <Group title={t('imports.mapping.teams')} hint={t('imports.mapping.teamsHint')}>
        {summary.teams.map((src) => {
          const target = mapping.teams[src.id];
          return (
            <div key={src.id} className="border-b border-border-soft/60 last:border-0">
              <Row
                left={
                  <span>
                    {src.name}
                    {src.key && (
                      <span className="ml-2 font-mono text-[11px] text-index">{src.key}</span>
                    )}
                  </span>
                }
                count={src.issueCount}
              >
                <select
                  className={select}
                  value={teamValue(target)}
                  onChange={(e) => {
                    const v = e.target.value;
                    const next: ImportTeamTarget =
                      v === 'skip'
                        ? { skip: true }
                        : v === 'create'
                          ? {
                              create: {
                                name: src.name.slice(0, 120),
                                key:
                                  (src.key ?? src.name)
                                    .toUpperCase()
                                    .replace(/[^A-Z0-9]/g, '')
                                    .slice(0, 7) || 'IMP',
                              },
                            }
                          : { teamId: v.slice(5) };
                    // A different target means different statuses: match them again, by name
                    // then by kind, as the suggested mapping does.
                    const states =
                      'teamId' in next
                        ? [...(ws.teamById.get(next.teamId)?.states ?? [])].sort(
                            (a, b) => a.position - b.position,
                          )
                        : null;
                    const lower = (x: string) => x.trim().toLowerCase();
                    onChange({
                      ...mapping,
                      teams: { ...mapping.teams, [src.id]: next },
                      statuses: {
                        ...mapping.statuses,
                        // No match leaves the status out: the team's default.
                        [src.id]: Object.fromEntries(
                          src.statuses
                            .map((s) => [
                              s.name,
                              states
                                ? ((
                                    states.find((x) => lower(x.name) === lower(s.name)) ??
                                    states.find((x) => x.type === s.type)
                                  )?.id ?? '')
                                : (s.type ?? 'backlog'),
                            ])
                            .filter(([, v]) => v),
                        ),
                      },
                    });
                  }}
                >
                  {ws.teams.map((x) => (
                    <option key={x.id} value={`team:${x.id}`}>
                      {x.name} ({x.key})
                    </option>
                  ))}
                  <option value="create">{t('imports.mapping.newTeam')}</option>
                  <option value="skip">{t('imports.mapping.dontImport')}</option>
                </select>
              </Row>
              {target && 'create' in target && (
                <div className="flex gap-2 px-3 pb-2">
                  <input
                    className="input h-8 flex-1 text-[12.5px]"
                    aria-label={t('imports.mapping.newTeamName')}
                    value={target.create.name}
                    onChange={(e) =>
                      set('teams', {
                        ...mapping.teams,
                        [src.id]: { create: { ...target.create, name: e.target.value } },
                      })
                    }
                  />
                  <input
                    className="input h-8 w-24 font-mono text-[12.5px] uppercase"
                    aria-label={t('imports.mapping.newTeamKey')}
                    value={target.create.key}
                    onChange={(e) =>
                      set('teams', {
                        ...mapping.teams,
                        [src.id]: {
                          create: {
                            ...target.create,
                            key: e.target.value.toUpperCase().slice(0, 7),
                          },
                        },
                      })
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </Group>

      {summary.teams
        .filter(
          (src) => src.statuses.length && !('skip' in (mapping.teams[src.id] ?? { skip: true })),
        )
        .map((src) => {
          const target = mapping.teams[src.id]!;
          const team = 'teamId' in target ? ws.teamById.get(target.teamId) : undefined;
          return (
            <Group key={src.id} title={t('imports.mapping.statusesFor', { team: src.name })}>
              {src.statuses.map((s) => (
                <Row key={s.name} left={s.name} count={s.count}>
                  <select
                    className={select}
                    value={mapping.statuses[src.id]?.[s.name] ?? ''}
                    onChange={(e) => {
                      // The team's default is no entry at all.
                      const { [s.name]: _, ...rest } = mapping.statuses[src.id] ?? {};
                      set('statuses', {
                        ...mapping.statuses,
                        [src.id]: e.target.value ? { ...rest, [s.name]: e.target.value } : rest,
                      });
                    }}
                  >
                    <option value="">{t('imports.mapping.teamDefault')}</option>
                    {team
                      ? [...team.states]
                          .sort((a, b) => a.position - b.position)
                          .map((st) => (
                            <option key={st.id} value={st.id}>
                              {st.name}
                            </option>
                          ))
                      : STATE_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {stateTypeLabel(type)}
                          </option>
                        ))}
                  </select>
                </Row>
              ))}
            </Group>
          );
        })}

      {people.length > 0 && (
        <Group title={t('imports.mapping.people')} hint={t('imports.mapping.peopleHint')}>
          <div className="max-h-80 overflow-y-auto">
            {people.map((u) => (
              <Row
                key={u.id}
                left={
                  <span>
                    {u.name}
                    {u.email && u.email !== u.name && (
                      <span className="ml-2 text-[11.5px] text-index">{u.email}</span>
                    )}
                  </span>
                }
                count={u.count}
              >
                <select
                  className={select}
                  value={mapping.users[u.id] ?? ''}
                  onChange={(e) =>
                    set('users', { ...mapping.users, [u.id]: e.target.value || null })
                  }
                >
                  <option value="placeholder">{t('imports.mapping.newPlaceholder')}</option>
                  <option value="">{t('imports.mapping.nobody')}</option>
                  <optgroup label={t('imports.mapping.members')}>
                    {ws.members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                  {(ws.placeholders ?? []).length > 0 && (
                    <optgroup label={t('imports.mapping.placeholders')}>
                      {ws.placeholders.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </Row>
            ))}
          </div>
        </Group>
      )}

      {summary.labels.length > 0 && (
        <Group title={t('imports.mapping.labels')}>
          {summary.labels.map((l) => (
            <Row key={l.id} left={l.name} count={l.count}>
              <select
                className={select}
                value={mapping.labels[l.id] ?? 'create'}
                onChange={(e) => set('labels', { ...mapping.labels, [l.id]: e.target.value })}
              >
                <option value="create">{t('imports.mapping.newLabel')}</option>
                <option value="skip">{t('imports.mapping.leaveOff')}</option>
                {workspaceLabels.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Row>
          ))}
        </Group>
      )}

      {summary.projects.length > 0 && (
        <Group title={t('imports.mapping.projects')}>
          {summary.projects.map((p) => (
            <Row key={p.id} left={p.name} count={p.count}>
              <select
                className={select}
                value={mapping.projects[p.id] ?? 'create'}
                onChange={(e) => set('projects', { ...mapping.projects, [p.id]: e.target.value })}
              >
                <option value="create">{t('imports.mapping.newProject')}</option>
                <option value="skip">{t('imports.mapping.leaveOut')}</option>
                {ws.projects.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Row>
          ))}
        </Group>
      )}

      <label className="mb-2 flex items-start gap-2 text-[13px]">
        <input
          type="checkbox"
          className="mt-0.5 accent-primary"
          checked={mapping.keepNumbers}
          onChange={(e) => set('keepNumbers', e.target.checked)}
        />
        <span>
          {t('imports.mapping.keepNumbers')}
          <span className="block text-[12px] text-muted">
            {t('imports.mapping.keepNumbersHint')}
          </span>
        </span>
      </label>
    </>
  );
}

const CREATED: (keyof ImportReport['created'])[] = [
  'issues',
  'comments',
  'relations',
  'teams',
  'people',
  'labels',
  'projects',
  'cycles',
];

export function ImportReportView({ report }: { report: ImportReport }) {
  const cells = CREATED.filter((key) => key === 'issues' || report.created[key]);
  return (
    <div className="mb-6">
      <div className="mb-2 font-mono text-[10.5px] font-semibold tracking-[0.16em] text-index uppercase">
        {report.dryRun ? t('imports.report.wouldCreate') : t('imports.report.created')}
      </div>
      {/* Lines as borders, not a gap colour, so a short last row leaves no block behind. */}
      <div className="grid grid-cols-2 border-t border-l border-border-soft sm:grid-cols-4">
        {cells.map((key) => (
          <div key={key} className="border-r border-b border-border-soft bg-bg px-3 py-2.5">
            <div className="font-mono text-[10px] tracking-[0.16em] text-index uppercase">
              {t(`imports.report.counts.${key}`)}
            </div>
            <div className="mt-0.5 font-mono text-[18px] font-semibold">{report.created[key]}</div>
          </div>
        ))}
      </div>
      {report.existing > 0 && (
        <p className="mt-2 text-[12px] text-muted">
          {t('imports.report.existing', { count: report.existing })}
        </p>
      )}
      <Problems
        title={t('imports.report.skipped', { count: report.skippedCount })}
        items={report.skipped}
        count={report.skippedCount}
        tone="text-error"
      />
      <Problems
        title={t('imports.report.warnings', { count: report.warningCount })}
        items={report.warnings}
        count={report.warningCount}
        tone="text-warning"
      />
    </div>
  );
}

function Problems({
  title,
  items,
  count,
  tone,
}: {
  title: string;
  items: ImportReport['skipped'];
  count: number;
  tone: string;
}) {
  if (!count) return null;
  return (
    <div className="mt-4">
      <div className={`mb-1 font-mono text-[10.5px] tracking-[0.16em] uppercase ${tone}`}>
        {title}
      </div>
      <div className="max-h-48 overflow-y-auto border border-border-soft">
        {items.map((p, i) => (
          <div
            key={`${p.item}-${i}`}
            className="flex gap-3 border-b border-border-soft/60 px-3 py-1.5 text-[12.5px] last:border-0"
          >
            {p.item && (
              <span className="w-32 flex-none truncate font-mono text-[11.5px] text-index">
                {p.item}
              </span>
            )}
            <span className="min-w-0 flex-1">{p.message}</span>
          </div>
        ))}
        {count > items.length && (
          <div className="px-3 py-1.5 font-mono text-[11.5px] text-index">
            {t('imports.report.andMore', { count: count - items.length })}
          </div>
        )}
      </div>
    </div>
  );
}
