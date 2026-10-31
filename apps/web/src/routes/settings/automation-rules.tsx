import {
  AUTOMATION_FIELDS,
  AUTOMATION_TRIGGERS,
  type AutomationActions,
  type AutomationConditions,
  type AutomationRule,
  type AutomationTrigger,
  type AutomationTriggerType,
  dayInZone,
  type Team,
} from '@ordo/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, wsPath } from '../../api/client.ts';
import { useWsMutation } from '../../api/queries.ts';
import {
  assigneeOptions,
  labelOptions,
  Picker,
  priorityOptions,
  projectOptions,
  statusOptions,
} from '../../components/properties.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import type messages from '../../i18n/en/automationRules.ts';
import { type Params, t } from '../../i18n/index.ts';
import { priorityLabel } from '../../i18n/labels.ts';
import { relativeTime } from '../../lib/format.ts';
import { cycleName, upcomingCycles, useWorkspace } from '../../lib/workspace.tsx';
import { SettingsCard } from './ui.tsx';

type Messages = typeof messages;
type Draft = {
  name: string;
  trigger: AutomationTrigger;
  conditions: AutomationConditions;
  actions: AutomationActions;
};

const triggerLabel = (type: AutomationTriggerType) => t(`automationRules.trigger.${type}`);
const fieldLabel = (f: (typeof AUTOMATION_FIELDS)[number]) => t(`automationRules.field.${f}`);

function toggle<T extends string | number>(list: T[] | undefined, v: T) {
  const set = new Set(list ?? []);
  if (set.has(v)) set.delete(v);
  else set.add(v);
  return [...set];
}

/** "When a label is added (Security): priority Urgent, assign Sasha". */
function useSummary() {
  const ws = useWorkspace();
  const s = (key: keyof Messages['summary'] & string, vars?: Params) =>
    t(`automationRules.summary.${key}`, vars);
  const or = s('or');
  const labels = (ids?: string[]) =>
    (ids ?? []).map((id) => ws.labelById.get(id)?.name ?? s('label')).join(', ');
  const person = (id: string | null | undefined) =>
    id === 'none' || id === null
      ? s('nobody')
      : (ws.memberById.get(id ?? '')?.name ?? s('someone'));
  const status = (id: string) => ws.stateById.get(id)?.name ?? s('aStatus');
  const project = (id: string | null) =>
    id === 'none' || id === null ? s('none') : (ws.projectById.get(id)?.name ?? s('aProject'));
  return (r: Draft) => {
    const tr = r.trigger;
    const detail =
      tr.type === 'status_changed' && tr.stateIds?.length
        ? tr.stateIds.map(status).join(or)
        : tr.type === 'label_added' && tr.labelIds?.length
          ? labels(tr.labelIds)
          : tr.type === 'issue_updated' && tr.fields?.length
            ? tr.fields.map(fieldLabel).join(or)
            : '';
    const trigger = `${triggerLabel(tr.type)}${detail ? ` (${detail})` : ''}`;
    const c = r.conditions;
    const ifs = [
      c.stateIds?.length && s('status', { statuses: c.stateIds.map(status).join(or) }),
      c.priorities?.length &&
        s('priority', { priorities: c.priorities.map((p) => priorityLabel(p)).join(or) }),
      c.labelIds?.length && s('labeled', { labels: labels(c.labelIds) }),
      c.assigneeIds?.length && s('assignee', { people: c.assigneeIds.map(person).join(or) }),
      c.projectIds?.length && s('inProject', { projects: c.projectIds.map(project).join(or) }),
      c.q && s('mentions', { text: c.q }),
    ].filter((x): x is string => !!x);
    const a = r.actions;
    const then = [
      a.stateId && s('setStatus', { status: status(a.stateId) }),
      a.priority !== undefined && s('setPriority', { priority: priorityLabel(a.priority) }),
      a.assigneeId === null
        ? s('unassign')
        : a.assigneeId && s('assign', { person: person(a.assigneeId) }),
      a.addLabelIds?.length && s('addLabels', { labels: labels(a.addLabelIds) }),
      a.removeLabelIds?.length && s('removeLabels', { labels: labels(a.removeLabelIds) }),
      a.cycleId === 'active'
        ? s('activeCycle')
        : a.cycleId === null
          ? s('noCycle')
          : a.cycleId &&
            s('cycle', {
              cycle: (() => {
                const cy = ws.cycleById.get(a.cycleId);
                return cy ? cycleName(cy) : s('aCycle');
              })(),
            }),
      a.projectId === null
        ? s('noProject')
        : a.projectId && s('project', { project: project(a.projectId) }),
      a.comment && s('comment'),
    ].filter((x): x is string => !!x);
    return s('rule', {
      trigger,
      conditions: ifs.length ? s('conditions', { conditions: ifs.join(s('and')) }) : '',
      actions: then.join(', ') || s('nothingYet'),
    });
  };
}

/** Drops empty lists, blank text and unset values, so the server stores only what was chosen. */
function clean(d: Draft): Draft {
  const keep = (o: object) =>
    Object.fromEntries(
      Object.entries(o).filter(([, v]) =>
        Array.isArray(v) ? v.length : v !== undefined && v !== '',
      ),
    );
  return {
    name: d.name.trim(),
    trigger: keep(d.trigger) as AutomationTrigger,
    conditions: keep({ ...d.conditions, q: d.conditions.q?.trim() }),
    actions: keep({ ...d.actions, comment: d.actions.comment?.trim() }),
  };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-center gap-3 py-1.5 text-[13px]">
      <span className="text-index">{label}</span>
      {children}
    </div>
  );
}

function RuleEditor({
  team,
  rule,
  onClose,
}: {
  team: Team;
  rule?: AutomationRule;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const summary = useSummary();
  const [draft, setDraft] = useState<Draft>(
    rule ?? { name: '', trigger: { type: 'issue_created' }, conditions: {}, actions: {} },
  );
  const cond = (c: Partial<AutomationConditions>) =>
    setDraft((d) => ({ ...d, conditions: { ...d.conditions, ...c } }));
  const act = (a: Partial<AutomationActions>) =>
    setDraft((d) => ({ ...d, actions: { ...d.actions, ...a } }));
  const setTrigger = (trigger: AutomationTrigger) => setDraft((d) => ({ ...d, trigger }));
  const save = useWsMutation(ws.slug, (body: Draft) =>
    rule
      ? api.patch(wsPath(ws.slug, `/automation-rules/${rule.id}`), body)
      : api.post(wsPath(ws.slug, `/teams/${team.id}/automation-rules`), body),
  );
  const cleaned = clean(draft);
  const hasAction = Object.keys(cleaned.actions).length > 0;

  const chip = (text: string) => (
    <button type="button" className="prop max-w-full justify-start">
      <span className="truncate">{text}</span>
    </button>
  );
  const names = (ids: string[] | undefined, name: (id: string) => string | undefined) =>
    ids?.length ? ids.map((id) => name(id) ?? '?').join(', ') : undefined;
  const labelName = (id: string) => ws.labelById.get(id)?.name;
  const stateName = (id: string) => ws.stateById.get(id)?.name;
  const people = assigneeOptions(ws);
  const personName = (id: string) =>
    id === 'none' ? t('issues.none.assignee') : ws.memberById.get(id)?.name;
  const projects = projectOptions(ws, team.id);
  const projectName = (id: string) =>
    id === 'none' ? t('issues.none.project') : ws.projectById.get(id)?.name;
  const cycles = team.cyclesEnabled
    ? upcomingCycles(ws.cycles, team.id, dayInZone(ws.workspace.settings.timezone))
    : [];
  const tr = draft.trigger;
  const kicker = (text: string) => (
    <div className="kicker mt-5 mb-1 text-[11px] uppercase tracking-[0.14em]">{text}</div>
  );
  const e = (key: keyof Messages['editor'] & string) => t(`automationRules.editor.${key}`);

  return (
    <Modal open onClose={onClose} width={640} label={rule ? e('edit') : e('new')}>
      <form
        className="max-h-[85vh] overflow-y-auto p-5"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!cleaned.name || !hasAction) return;
          save.mutate(cleaned, { onSuccess: onClose });
        }}
      >
        <div className="section-label mb-3">{rule ? e('edit') : e('new')}</div>
        <input
          className="input"
          placeholder={e('namePlaceholder')}
          value={draft.name}
          onChange={(ev) => setDraft({ ...draft, name: ev.target.value })}
        />

        {kicker(e('when'))}
        <Row label={e('happens')}>
          <select
            className="input h-8"
            value={tr.type}
            onChange={(ev) => setTrigger({ type: ev.target.value as AutomationTriggerType })}
          >
            {AUTOMATION_TRIGGERS.map((type) => (
              <option key={type} value={type}>
                {triggerLabel(type)}
              </option>
            ))}
          </select>
        </Row>
        {tr.type === 'issue_updated' && (
          <Row label={e('fields')}>
            <Picker
              multi
              placeholder={e('fields')}
              options={AUTOMATION_FIELDS.map((f) => ({ value: f, label: fieldLabel(f) }))}
              selected={tr.fields ?? []}
              onSelect={(v) =>
                setTrigger({
                  ...tr,
                  fields: toggle(tr.fields, v as (typeof AUTOMATION_FIELDS)[number]),
                })
              }
              trigger={chip(names(tr.fields, (f) => fieldLabel(f as never)) ?? e('anyField'))}
            />
          </Row>
        )}
        {tr.type === 'status_changed' && (
          <Row label={e('statuses')}>
            <Picker
              multi
              placeholder={e('statuses')}
              options={statusOptions(ws, team.id)}
              selected={tr.stateIds ?? []}
              onSelect={(v) => setTrigger({ ...tr, stateIds: toggle(tr.stateIds, v) })}
              trigger={chip(names(tr.stateIds, stateName) ?? e('anyStatus'))}
            />
          </Row>
        )}
        {tr.type === 'label_added' && (
          <Row label={e('labels')}>
            <Picker
              multi
              placeholder={e('labels')}
              options={labelOptions(ws, team.id)}
              selected={tr.labelIds ?? []}
              onSelect={(v) => setTrigger({ ...tr, labelIds: toggle(tr.labelIds, v) })}
              trigger={chip(names(tr.labelIds, labelName) ?? e('anyLabel'))}
            />
          </Row>
        )}
        {(tr.type === 'pull_request_opened' || tr.type === 'pull_request_merged') && (
          <p className="text-[12px] text-index">{e('pullRequestHint')}</p>
        )}
        {tr.type === 'sub_issues_completed' && (
          <p className="text-[12px] text-index">{e('subIssuesHint')}</p>
        )}

        {kicker(e('ifHeading'))}
        <Row label={e('status')}>
          <Picker
            multi
            placeholder={e('status')}
            options={statusOptions(ws, team.id)}
            selected={draft.conditions.stateIds ?? []}
            onSelect={(v) => cond({ stateIds: toggle(draft.conditions.stateIds, v) })}
            trigger={chip(names(draft.conditions.stateIds, stateName) ?? e('any'))}
          />
        </Row>
        <Row label={e('priority')}>
          <Picker
            multi
            placeholder={e('priority')}
            options={priorityOptions()}
            selected={(draft.conditions.priorities ?? []).map(String)}
            onSelect={(v) => cond({ priorities: toggle(draft.conditions.priorities, Number(v)) })}
            trigger={chip(
              draft.conditions.priorities?.length
                ? draft.conditions.priorities.map((p) => priorityLabel(p)).join(', ')
                : e('any'),
            )}
          />
        </Row>
        <Row label={e('hasLabel')}>
          <Picker
            multi
            placeholder={e('hasLabel')}
            options={labelOptions(ws, team.id)}
            selected={draft.conditions.labelIds ?? []}
            onSelect={(v) => cond({ labelIds: toggle(draft.conditions.labelIds, v) })}
            trigger={chip(names(draft.conditions.labelIds, labelName) ?? e('any'))}
          />
        </Row>
        <Row label={e('assignee')}>
          <Picker
            multi
            placeholder={e('assignee')}
            options={people}
            selected={draft.conditions.assigneeIds ?? []}
            onSelect={(v) => cond({ assigneeIds: toggle(draft.conditions.assigneeIds, v) })}
            trigger={chip(names(draft.conditions.assigneeIds, personName) ?? e('any'))}
          />
        </Row>
        <Row label={e('project')}>
          <Picker
            multi
            placeholder={e('project')}
            options={projects}
            selected={draft.conditions.projectIds ?? []}
            onSelect={(v) => cond({ projectIds: toggle(draft.conditions.projectIds, v) })}
            trigger={chip(names(draft.conditions.projectIds, projectName) ?? e('any'))}
          />
        </Row>
        <Row label={e('mentions')}>
          <input
            className="input h-8"
            placeholder={e('mentionsPlaceholder')}
            value={draft.conditions.q ?? ''}
            onChange={(ev) => cond({ q: ev.target.value })}
          />
        </Row>

        {kicker(e('thenHeading'))}
        <Row label={e('setStatus')}>
          <select
            className="input h-8"
            value={draft.actions.stateId ?? ''}
            onChange={(ev) => act({ stateId: ev.target.value || undefined })}
          >
            <option value="">{e('leaveAsIs')}</option>
            {team.states
              .filter((s) => s.type !== 'triage')
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </Row>
        <Row label={e('setPriority')}>
          <select
            className="input h-8"
            value={draft.actions.priority ?? ''}
            onChange={(ev) =>
              act({ priority: ev.target.value === '' ? undefined : Number(ev.target.value) })
            }
          >
            <option value="">{e('leaveAsIs')}</option>
            {[1, 2, 3, 4, 0].map((p) => (
              <option key={p} value={p}>
                {priorityLabel(p)}
              </option>
            ))}
          </select>
        </Row>
        <Row label={e('assign')}>
          <span className="flex min-w-0 items-center gap-2">
            <Picker
              placeholder={e('assign')}
              options={[
                { value: '', label: e('leaveAsIs') },
                ...people.map((o) => (o.value === 'none' ? { ...o, label: e('unassign') } : o)),
              ]}
              selected={
                draft.actions.assigneeId === undefined ? [''] : [draft.actions.assigneeId ?? 'none']
              }
              onSelect={(v) => act({ assigneeId: v === '' ? undefined : v === 'none' ? null : v })}
              trigger={chip(
                draft.actions.assigneeId === undefined
                  ? e('leaveAsIs')
                  : draft.actions.assigneeId === null
                    ? e('unassign')
                    : (personName(draft.actions.assigneeId) ?? '?'),
              )}
            />
            <span className="truncate text-[11.5px] text-index">{e('assignHint')}</span>
          </span>
        </Row>
        <Row label={e('addLabels')}>
          <Picker
            multi
            placeholder={e('addLabels')}
            options={labelOptions(ws, team.id)}
            selected={draft.actions.addLabelIds ?? []}
            onSelect={(v) => act({ addLabelIds: toggle(draft.actions.addLabelIds, v) })}
            trigger={chip(names(draft.actions.addLabelIds, labelName) ?? e('none'))}
          />
        </Row>
        <Row label={e('removeLabels')}>
          <Picker
            multi
            placeholder={e('removeLabels')}
            options={labelOptions(ws, team.id)}
            selected={draft.actions.removeLabelIds ?? []}
            onSelect={(v) => act({ removeLabelIds: toggle(draft.actions.removeLabelIds, v) })}
            trigger={chip(names(draft.actions.removeLabelIds, labelName) ?? e('none'))}
          />
        </Row>
        {team.cyclesEnabled && (
          <Row label={e('cycle')}>
            <select
              className="input h-8"
              value={draft.actions.cycleId === undefined ? '' : (draft.actions.cycleId ?? 'none')}
              onChange={(ev) => {
                const v = ev.target.value;
                act({ cycleId: v === '' ? undefined : v === 'none' ? null : v });
              }}
            >
              <option value="">{e('leaveAsIs')}</option>
              <option value="active">{e('activeCycle')}</option>
              <option value="none">{e('removeFromCycle')}</option>
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>
                  {cycleName(c)}
                </option>
              ))}
            </select>
          </Row>
        )}
        <Row label={e('setProject')}>
          <select
            className="input h-8"
            value={draft.actions.projectId === undefined ? '' : (draft.actions.projectId ?? 'none')}
            onChange={(ev) => {
              const v = ev.target.value;
              act({ projectId: v === '' ? undefined : v === 'none' ? null : v });
            }}
          >
            <option value="">{e('leaveAsIs')}</option>
            <option value="none">{e('removeFromProject')}</option>
            {projects
              .filter((p) => p.value !== 'none')
              .map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
          </select>
        </Row>
        <div className="grid grid-cols-[7.5rem_1fr] items-start gap-3 py-1.5 text-[13px]">
          <span className="pt-1.5 text-index">{e('comment')}</span>
          <textarea
            className="input min-h-[4.5rem] py-1.5"
            placeholder={e('commentPlaceholder')}
            value={draft.actions.comment ?? ''}
            onChange={(ev) => act({ comment: ev.target.value })}
          />
        </div>

        <p className="mt-4 font-mono text-[11.5px] text-index">// {summary(cleaned)}</p>
        {!hasAction && <p className="mt-1 text-[12px] text-index">{e('needsAction')}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!cleaned.name || !hasAction || save.isPending}
          >
            {rule ? t('common.save') : e('create')} <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** "When … then …" rules for the team's issues. */
export function AutomationRulesCard({ team }: { team: Team }) {
  const ws = useWorkspace();
  const summary = useSummary();
  const [editing, setEditing] = useState<AutomationRule | 'new' | null>(null);
  const flip = useWsMutation(ws.slug, (r: AutomationRule) =>
    api.patch(wsPath(ws.slug, `/automation-rules/${r.id}`), { enabled: !r.enabled }),
  );
  const remove = useWsMutation(ws.slug, (r: AutomationRule) =>
    api.del(wsPath(ws.slug, `/automation-rules/${r.id}`)),
  );
  return (
    <SettingsCard title={t('automationRules.title')} description={t('automationRules.description')}>
      {team.automationRules.length === 0 && (
        <p className="text-[13px] text-index">{t('automationRules.empty')}</p>
      )}
      {team.automationRules.map((r) => (
        <div key={r.id} className="flex items-center gap-3 border-b border-border-soft py-2">
          <input
            type="checkbox"
            className="accent-primary"
            checked={r.enabled}
            onChange={() => flip.mutate(r)}
            aria-label={
              r.enabled
                ? t('automationRules.disable', { name: r.name })
                : t('automationRules.enable', { name: r.name })
            }
          />
          <div className={`min-w-0 flex-1 ${r.enabled ? '' : 'opacity-50'}`}>
            <div className="text-[13.5px]">
              {r.name}
              {r.lastRunAt && (
                <span className="ml-2 text-[11px] text-index">
                  {t('automationRules.runs', {
                    count: r.runCount,
                    when: relativeTime(r.lastRunAt),
                  })}
                </span>
              )}
            </div>
            <div className="truncate font-mono text-[11px] text-index">{summary(r)}</div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setEditing(r)}
            aria-label={t('automationRules.editLabel', { name: r.name })}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={async () => {
              if (
                await confirmDialog({
                  title: t('automationRules.confirmDelete', { name: r.name }),
                  danger: true,
                })
              )
                remove.mutate(r);
            }}
            aria-label={t('automationRules.deleteLabel', { name: r.name })}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={() => setEditing('new')}>
        <Plus size={13} /> {t('automationRules.addRule')}
      </button>
      {editing && (
        <RuleEditor
          team={team}
          rule={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsCard>
  );
}
