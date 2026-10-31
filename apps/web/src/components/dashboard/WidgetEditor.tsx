import {
  BREAKDOWN_SLICES,
  DASHBOARD_CHARTS,
  DASHBOARD_WEEKS,
  DASHBOARD_WIDGET_TYPES,
  type DashboardChart,
  type DashboardWidget,
  type DashboardWidgetType,
  dashboardWidgetSchema,
  type IssueFilter,
} from '@ordo/shared';
import { useState } from 'react';
import { t } from '../../i18n/index.ts';
import { newWidgetId } from '../../lib/dashboards.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { FilterButton, FilterChips } from '../FilterBar.tsx';
import { Modal } from '../ui/Modal.tsx';

/** A widget being edited: any field of any type, checked against the schema on save. */
type Draft = Record<string, unknown> & { id: string; type: DashboardWidgetType };

const AGENT_DAYS = [1, 7, 14, 30, 90];
const TIMELINE: DashboardChart[] = ['burnUp', 'cumulativeFlow'];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mt-4 block text-[12px] text-muted">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

/** Team picker plus the filter bar's conditions; the team is the filter's own `teamId`. */
function FilterField({
  filter,
  onChange,
}: {
  filter: IssueFilter;
  onChange: (f: IssueFilter) => void;
}) {
  const ws = useWorkspace();
  const teamId = filter.teamId;
  return (
    <div className="mt-4">
      <div className="text-[12px] text-muted">{t('dashboards.editor.issues')}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <select
          className="input h-8 w-auto"
          value={teamId ?? ''}
          onChange={(e) => {
            const { teamId: _, ...rest } = filter;
            onChange(e.target.value ? { ...rest, teamId: e.target.value } : rest);
          }}
          aria-label={t('dashboards.editor.team')}
        >
          <option value="">{t('dashboards.editor.allTeams')}</option>
          {ws.teams.map((tm) => (
            <option key={tm.id} value={tm.id}>
              {tm.name}
            </option>
          ))}
        </select>
        <FilterButton filter={filter} onChange={onChange} teamId={teamId} />
      </div>
      <div className="-mx-4 mt-1">
        <FilterChips filter={filter} onChange={onChange} teamId={teamId} />
      </div>
    </div>
  );
}

export function WidgetEditor({
  widget,
  onClose,
  onSave,
}: {
  /** The widget to edit; null adds one. */
  widget: DashboardWidget | null;
  onClose: () => void;
  onSave: (w: DashboardWidget) => void;
}) {
  const ws = useWorkspace();
  const [draft, setDraft] = useState<Draft>(
    () => (widget as Draft | null) ?? { id: newWidgetId(), type: 'count', filters: {}, w: 1 },
  );
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Record<string, unknown>) => {
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const agents = ws.members.filter((m) => m.kind === 'agent');
  const chart = (draft.chart as DashboardChart | undefined) ?? 'burnUp';

  // Only new widgets change type: each starts at a size that suits it.
  const switchType = (type: DashboardWidgetType) => {
    const start: Record<DashboardWidgetType, Record<string, unknown>> = {
      count: { filters: {}, w: 1 },
      view: { viewId: ws.views[0]?.id, w: 2, h: 2 },
      chart: { chart: 'burnUp', w: 2 },
      agents: { days: 7, w: 2 },
    };
    setError(null);
    setDraft({ id: draft.id, title: draft.title, type, ...start[type] });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = dashboardWidgetSchema.safeParse(draft);
    // The editor only offers valid values, so what's left is a choice not made yet.
    if (!parsed.success) return setError(t('dashboards.editor.incomplete'));
    onSave(parsed.data);
  };

  // A timeline chart's scope as one select: workspace, a team, a team's cycle, or a project.
  const scope = draft.currentCycle
    ? `cycle:${draft.teamId}`
    : draft.projectId
      ? `project:${draft.projectId}`
      : draft.teamId
        ? `team:${draft.teamId}`
        : '';
  const setScope = (value: string) => {
    const [kind, id] = value.split(':');
    set({
      teamId: kind === 'team' || kind === 'cycle' ? id : null,
      projectId: kind === 'project' ? id : null,
      currentCycle: kind === 'cycle' || undefined,
    });
  };
  const select = 'input h-8';

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      label={widget ? t('dashboards.editor.editTitle') : t('dashboards.editor.addTitle')}
    >
      <form onSubmit={submit} className="p-6">
        <div className="section-label mb-4">
          {widget ? t('dashboards.editor.editTitle') : t('dashboards.editor.addTitle')}
        </div>
        {!widget && (
          <div className="grid grid-cols-2 gap-px bg-border-soft sm:grid-cols-4" role="radiogroup">
            {DASHBOARD_WIDGET_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={draft.type === type}
                onClick={() => switchType(type)}
                className={`bg-surface px-3 py-2.5 text-left ${draft.type === type ? 'text-text shadow-[inset_0_-2px_0_var(--color-primary)]' : 'text-muted hover:text-text'}`}
              >
                <div className="text-[13px] font-medium">{t(`dashboards.types.${type}.name`)}</div>
                <div className="mt-0.5 text-[11px] text-index">
                  {t(`dashboards.types.${type}.hint`)}
                </div>
              </button>
            ))}
          </div>
        )}

        <Field label={t('dashboards.editor.title')}>
          <input
            className="input"
            value={(draft.title as string | undefined) ?? ''}
            onChange={(e) => set({ title: e.target.value || null })}
            placeholder={t('dashboards.editor.titlePlaceholder')}
          />
        </Field>

        {draft.type === 'count' && (
          <FilterField
            filter={(draft.filters as IssueFilter) ?? {}}
            onChange={(filters) => set({ filters })}
          />
        )}

        {draft.type === 'view' &&
          (ws.views.length === 0 ? (
            <p className="mt-4 text-[13px] text-muted">{t('dashboards.editor.noViews')}</p>
          ) : (
            <div className="flex gap-3">
              <div className="flex-1">
                <Field label={t('dashboards.editor.view')}>
                  <select
                    className={select}
                    value={(draft.viewId as string | undefined) ?? ''}
                    onChange={(e) => set({ viewId: e.target.value })}
                  >
                    {ws.views.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label={t('dashboards.editor.limit')}>
                <input
                  type="number"
                  min={1}
                  max={50}
                  className="input h-8 w-20"
                  value={(draft.limit as number | undefined) ?? 8}
                  onChange={(e) => set({ limit: Number(e.target.value) })}
                />
              </Field>
            </div>
          ))}

        {draft.type === 'chart' && (
          <>
            <Field label={t('dashboards.editor.chart')}>
              <select
                className={select}
                value={chart}
                onChange={(e) =>
                  set({
                    chart: e.target.value,
                    teamId: null,
                    projectId: null,
                    currentCycle: undefined,
                  })
                }
              >
                {DASHBOARD_CHARTS.map((c) => (
                  <option key={c} value={c}>
                    {t(`dashboards.charts.${c}`)}
                  </option>
                ))}
              </select>
            </Field>
            {TIMELINE.includes(chart) && (
              <Field label={t('dashboards.editor.scope')}>
                <select className={select} value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="">{t('insights.page.workspace')}</option>
                  <optgroup label={t('insights.page.teams')}>
                    {ws.teams.map((tm) => (
                      <option key={tm.id} value={`team:${tm.id}`}>
                        {tm.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t('dashboards.editor.currentCycles')}>
                    {ws.teams
                      .filter((tm) => tm.cyclesEnabled)
                      .map((tm) => (
                        <option key={tm.id} value={`cycle:${tm.id}`}>
                          {t('dashboards.editor.currentCycleOf', { team: tm.name })}
                        </option>
                      ))}
                  </optgroup>
                  {ws.projects.length > 0 && (
                    <optgroup label={t('insights.page.projects')}>
                      {ws.projects.map((p) => (
                        <option key={p.id} value={`project:${p.id}`}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </Field>
            )}
            {chart === 'burndown' && (
              <Field label={t('dashboards.editor.project')}>
                <select
                  className={select}
                  value={(draft.projectId as string | null) ?? ''}
                  onChange={(e) => set({ projectId: e.target.value || null })}
                >
                  <option value="">{t('dashboards.editor.choose')}</option>
                  {ws.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {chart === 'velocity' && (
              <Field label={t('dashboards.editor.team')}>
                <select
                  className={select}
                  value={(draft.teamId as string | null) ?? ''}
                  onChange={(e) => set({ teamId: e.target.value || null })}
                >
                  <option value="">{t('dashboards.editor.choose')}</option>
                  {ws.teams.map((tm) => (
                    <option key={tm.id} value={tm.id}>
                      {tm.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {(chart === 'breakdown' || chart === 'flow') && (
              <FilterField
                filter={(draft.filters as IssueFilter | undefined) ?? {}}
                onChange={(filters) => set({ filters })}
              />
            )}
            <div className="flex flex-wrap gap-3">
              {chart === 'breakdown' && (
                <Field label={t('insights.breakdown.by')}>
                  <select
                    className={`${select} w-auto`}
                    value={(draft.slice as string | undefined) ?? 'state'}
                    onChange={(e) => set({ slice: e.target.value })}
                  >
                    {BREAKDOWN_SLICES.map((s) => (
                      <option key={s} value={s}>
                        {t(`insights.breakdown.slice.${s}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {(chart === 'flow' ||
                (TIMELINE.includes(chart) && !draft.currentCycle) ||
                chart === 'burndown') && (
                <Field label={t('insights.page.range')}>
                  <select
                    className={`${select} w-auto`}
                    value={(draft.weeks as number | undefined) ?? ''}
                    onChange={(e) =>
                      set({ weeks: e.target.value ? Number(e.target.value) : undefined })
                    }
                  >
                    <option value="">
                      {draft.projectId
                        ? t('insights.page.sinceStart')
                        : t('insights.page.weeks', { count: 12 })}
                    </option>
                    {DASHBOARD_WEEKS.filter((w) => draft.projectId || w !== 12).map((w) => (
                      <option key={w} value={w}>
                        {t('insights.page.weeks', { count: w })}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          </>
        )}

        {(draft.type === 'count' || draft.type === 'chart') && (
          <Field label={t('insights.measure')}>
            <select
              className={`${select} w-auto`}
              value={(draft.measure as string | undefined) ?? 'count'}
              onChange={(e) => set({ measure: e.target.value })}
            >
              <option value="count">{t('insights.issues')}</option>
              <option value="estimate">{t('insights.points')}</option>
            </select>
          </Field>
        )}

        {draft.type === 'agents' && (
          <div className="flex flex-wrap gap-3">
            <Field label={t('dashboards.editor.period')}>
              <select
                className={`${select} w-auto`}
                value={(draft.days as number | undefined) ?? 7}
                onChange={(e) => set({ days: Number(e.target.value) })}
              >
                {AGENT_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {t('dashboards.editor.lastDays', { count: d })}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('dashboards.editor.agent')}>
              <select
                className={`${select} w-auto`}
                value={(draft.agentId as string | null) ?? ''}
                onChange={(e) => set({ agentId: e.target.value || null })}
              >
                <option value="">{t('dashboards.editor.allAgents')}</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('dashboards.editor.team')}>
              <select
                className={`${select} w-auto`}
                value={(draft.teamId as string | null) ?? ''}
                onChange={(e) => set({ teamId: e.target.value || null })}
              >
                <option value="">{t('dashboards.editor.allTeams')}</option>
                {ws.teams.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        {error && (
          <p className="mt-4 text-[12.5px] text-error" role="alert">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={draft.type === 'view' && ws.views.length === 0}
          >
            {widget ? t('common.save') : t('dashboards.editor.add')}{' '}
            <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}
