import {
  type Team,
  TRIAGE_SOURCES,
  type TriageActions,
  type TriageConditions,
  type TriageRule,
} from '@ordo/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../../api/client.ts';
import { useWsMutation } from '../../api/queries.ts';
import {
  assigneeOptions,
  labelOptions,
  Picker,
  priorityOptions,
} from '../../components/properties.tsx';
import { confirmDialog, Modal } from '../../components/ui/Modal.tsx';
import { t } from '../../i18n/index.ts';
import { priorityLabel } from '../../i18n/labels.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { SettingsCard } from './ui.tsx';

const sourceLabel = (s: (typeof TRIAGE_SOURCES)[number]) => t(`triageRules.source.${s}`);

type Draft = { name: string; conditions: TriageConditions; actions: TriageActions };

/** "When from the API and mentions “crash”: priority Urgent, add Bug, assign in turn". */
function useSummary() {
  const ws = useWorkspace();
  const names = (ids?: string[]) =>
    (ids ?? [])
      .map((id) => ws.labelById.get(id)?.name ?? t('triageRules.summary.label'))
      .join(', ');
  const people = (ids?: string[]) =>
    (ids ?? [])
      .map((id) => ws.memberById.get(id)?.name.split(' ')[0] ?? t('triageRules.summary.someone'))
      .join(', ');
  return (r: Draft) => {
    const or = t('triageRules.summary.or');
    const c = r.conditions;
    const when = [
      c.sources?.length &&
        t('triageRules.summary.from', { sources: c.sources.map(sourceLabel).join(or) }),
      c.text && t('triageRules.summary.mentions', { text: c.text }),
      c.labelIds?.length && t('triageRules.summary.labeled', { labels: names(c.labelIds) }),
      c.priorities?.length &&
        t('triageRules.summary.priorityIs', {
          priorities: c.priorities.map((p) => priorityLabel(p)).join(or),
        }),
    ].filter(Boolean);
    const a = r.actions;
    const then = [
      a.priority !== undefined &&
        t('triageRules.summary.setPriority', { priority: priorityLabel(a.priority) }),
      a.labelIds?.length && t('triageRules.summary.addLabels', { labels: names(a.labelIds) }),
      a.rotation?.length
        ? t('triageRules.summary.assignInTurn', { people: people(a.rotation) })
        : a.assigneeId && t('triageRules.summary.assign', { person: people([a.assigneeId]) }),
      a.stateId &&
        t('triageRules.summary.acceptInto', {
          status: ws.stateById.get(a.stateId)?.name ?? t('triageRules.summary.aStatus'),
        }),
    ].filter(Boolean);
    const actions = then.join(', ') || t('triageRules.summary.nothingYet');
    return when.length
      ? t('triageRules.summary.when', {
          conditions: when.join(t('triageRules.summary.and')),
          actions,
        })
      : t('triageRules.summary.always', { actions });
  };
}

function multi(list: string[] | undefined, v: string) {
  const set = new Set(list ?? []);
  if (set.has(v)) set.delete(v);
  else set.add(v);
  return [...set];
}

function RuleEditor({
  team,
  rule,
  onClose,
}: {
  team: Team;
  rule?: TriageRule;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const summary = useSummary();
  const [draft, setDraft] = useState<Draft>(rule ?? { name: '', conditions: {}, actions: {} });
  const cond = (c: Partial<TriageConditions>) =>
    setDraft((d) => ({ ...d, conditions: { ...d.conditions, ...c } }));
  const act = (a: Partial<TriageActions>) =>
    setDraft((d) => ({ ...d, actions: { ...d.actions, ...a } }));
  const save = useWsMutation(ws.slug, (body: Draft) =>
    rule
      ? api.patch(wsPath(ws.slug, `/triage-rules/${rule.id}`), body)
      : api.post(wsPath(ws.slug, `/teams/${team.id}/triage-rules`), body),
  );
  const accept = team.states.filter((s) => s.type !== 'triage');
  const row = 'grid grid-cols-[7rem_1fr] items-center gap-3 py-1.5 text-[13px]';
  const chip = (text: string) => (
    <button type="button" className="prop max-w-full justify-start">
      <span className="truncate">{text}</span>
    </button>
  );
  const clean = (d: Draft): Draft => ({
    name: d.name,
    conditions: Object.fromEntries(
      Object.entries(d.conditions).filter(([, v]) => (Array.isArray(v) ? v.length : v)),
    ),
    actions: Object.fromEntries(
      Object.entries(d.actions).filter(([, v]) =>
        Array.isArray(v) ? v.length : v !== undefined && v !== '',
      ),
    ),
  });

  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      label={rule ? t('triageRules.editor.edit') : t('triageRules.editor.new')}
    >
      <form
        className="p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.name.trim()) return;
          save.mutate(clean(draft), { onSuccess: onClose });
        }}
      >
        <div className="section-label mb-3">
          {rule ? t('triageRules.editor.edit') : t('triageRules.editor.new')}
        </div>
        <input
          className="input"
          placeholder={t('triageRules.editor.namePlaceholder')}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />

        <div className="kicker mt-5 mb-1 text-[11px] uppercase tracking-[0.14em]">
          {t('triageRules.editor.when')}
        </div>
        <div className={row}>
          <span className="text-index">{t('triageRules.editor.comesFrom')}</span>
          <span className="flex flex-wrap gap-3">
            {TRIAGE_SOURCES.map((s) => (
              <label key={s} className="flex items-center gap-1.5 text-muted">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={draft.conditions.sources?.includes(s) ?? false}
                  onChange={() =>
                    cond({
                      sources: multi(
                        draft.conditions.sources,
                        s,
                      ) as (typeof TRIAGE_SOURCES)[number][],
                    })
                  }
                />
                {sourceLabel(s)}
              </label>
            ))}
          </span>
        </div>
        <div className={row}>
          <span className="text-index">{t('triageRules.editor.mentions')}</span>
          <input
            className="input h-8"
            placeholder={t('triageRules.editor.mentionsPlaceholder')}
            value={draft.conditions.text ?? ''}
            onChange={(e) => cond({ text: e.target.value })}
          />
        </div>
        <div className={row}>
          <span className="text-index">{t('triageRules.editor.hasLabel')}</span>
          <Picker
            multi
            placeholder={t('triageRules.editor.labelsPlaceholder')}
            options={labelOptions(ws, team.id)}
            selected={draft.conditions.labelIds ?? []}
            onSelect={(v) => cond({ labelIds: multi(draft.conditions.labelIds, v) })}
            trigger={chip(
              draft.conditions.labelIds?.length
                ? draft.conditions.labelIds.map((id) => ws.labelById.get(id)?.name).join(', ')
                : t('triageRules.editor.any'),
            )}
          />
        </div>
        <div className={row}>
          <span className="text-index">{t('triageRules.editor.hasPriority')}</span>
          <Picker
            multi
            placeholder={t('triageRules.editor.prioritiesPlaceholder')}
            options={priorityOptions()}
            selected={(draft.conditions.priorities ?? []).map(String)}
            onSelect={(v) =>
              cond({ priorities: multi(draft.conditions.priorities?.map(String), v).map(Number) })
            }
            trigger={chip(
              draft.conditions.priorities?.length
                ? draft.conditions.priorities.map((p) => priorityLabel(p)).join(', ')
                : t('triageRules.editor.any'),
            )}
          />
        </div>

        <div className="kicker mt-5 mb-1 text-[11px] uppercase tracking-[0.14em]">
          {t('triageRules.editor.thenHeading')}
        </div>
        <div className={row}>
          <span className="text-index">{t('triageRules.editor.setPriority')}</span>
          <select
            className="input h-8"
            value={draft.actions.priority ?? ''}
            onChange={(e) =>
              act({ priority: e.target.value === '' ? undefined : Number(e.target.value) })
            }
          >
            <option value="">{t('triageRules.editor.leaveAsIs')}</option>
            {[1, 2, 3, 4, 0].map((p) => (
              <option key={p} value={p}>
                {priorityLabel(p)}
              </option>
            ))}
          </select>
        </div>
        <div className={row}>
          <span className="text-index">{t('triageRules.editor.addLabels')}</span>
          <Picker
            multi
            placeholder={t('triageRules.editor.labelsPlaceholder')}
            options={labelOptions(ws, team.id)}
            selected={draft.actions.labelIds ?? []}
            onSelect={(v) => act({ labelIds: multi(draft.actions.labelIds, v) })}
            trigger={chip(
              draft.actions.labelIds?.length
                ? draft.actions.labelIds.map((id) => ws.labelById.get(id)?.name).join(', ')
                : t('common.none'),
            )}
          />
        </div>
        <div className={row}>
          <span className="text-index">{t('triageRules.editor.assign')}</span>
          <Picker
            multi
            placeholder={t('triageRules.editor.assignPlaceholder')}
            options={assigneeOptions(ws).filter((o) => o.value !== 'none')}
            selected={
              draft.actions.rotation ?? (draft.actions.assigneeId ? [draft.actions.assigneeId] : [])
            }
            onSelect={(v) => {
              const people = multi(
                draft.actions.rotation ??
                  (draft.actions.assigneeId ? [draft.actions.assigneeId] : []),
                v,
              );
              act(
                people.length > 1
                  ? { rotation: people, assigneeId: undefined }
                  : { assigneeId: people[0], rotation: undefined },
              );
            }}
            trigger={chip(
              draft.actions.rotation?.length
                ? t('triageRules.editor.inTurn', {
                    people: draft.actions.rotation
                      .map((id) => ws.memberById.get(id)?.name.split(' ')[0])
                      .join(', '),
                  })
                : draft.actions.assigneeId
                  ? (ws.memberById.get(draft.actions.assigneeId)?.name ??
                    t('triageRules.editor.someone'))
                  : t('triageRules.editor.nobody'),
            )}
          />
        </div>
        <div className={row}>
          <span className="text-index">{t('triageRules.editor.acceptInto')}</span>
          <select
            className="input h-8"
            value={draft.actions.stateId ?? ''}
            onChange={(e) => act({ stateId: e.target.value || undefined })}
          >
            <option value="">{t('triageRules.editor.keepInTriage')}</option>
            {accept.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <p className="mt-4 font-mono text-[11.5px] text-index">// {summary(draft)}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!draft.name.trim() || save.isPending}>
            {rule ? t('common.save') : t('triageRules.editor.create')}{' '}
            <span className="arrow">→</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Rules that sort issues arriving in this team's triage. */
export function TriageRulesCard({ team }: { team: Team }) {
  const ws = useWorkspace();
  const summary = useSummary();
  const [editing, setEditing] = useState<TriageRule | 'new' | null>(null);
  const toggle = useWsMutation(ws.slug, (r: TriageRule) =>
    api.patch(wsPath(ws.slug, `/triage-rules/${r.id}`), { enabled: !r.enabled }),
  );
  const remove = useWsMutation(ws.slug, (r: TriageRule) =>
    api.del(wsPath(ws.slug, `/triage-rules/${r.id}`)),
  );
  return (
    <SettingsCard title={t('triageRules.title')} description={t('triageRules.description')}>
      {team.triageRules.map((r) => (
        <div key={r.id} className="flex items-center gap-3 border-b border-border-soft py-2">
          <input
            type="checkbox"
            className="accent-primary"
            checked={r.enabled}
            onChange={() => toggle.mutate(r)}
            aria-label={
              r.enabled
                ? t('triageRules.disable', { name: r.name })
                : t('triageRules.enable', { name: r.name })
            }
          />
          <div className={`min-w-0 flex-1 ${r.enabled ? '' : 'opacity-50'}`}>
            <div className="text-[13.5px]">{r.name}</div>
            <div className="truncate font-mono text-[11px] text-index">{summary(r)}</div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setEditing(r)}
            aria-label={t('triageRules.editLabel', { name: r.name })}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={async () => {
              if (
                await confirmDialog({
                  title: t('triageRules.confirmDelete', { name: r.name }),
                  danger: true,
                })
              )
                remove.mutate(r);
            }}
            aria-label={t('triageRules.deleteLabel', { name: r.name })}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={() => setEditing('new')}>
        <Plus size={13} /> {t('triageRules.addRule')}
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
