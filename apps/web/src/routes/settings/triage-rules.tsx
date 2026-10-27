import {
  priorityLabel,
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
import { useWorkspace } from '../../lib/workspace.tsx';
import { SettingsCard } from './ui.tsx';

const SOURCE_LABELS: Record<(typeof TRIAGE_SOURCES)[number], string> = {
  web: 'the app',
  api: 'the API',
  mcp: 'AI agents',
  integration: 'integrations',
  email: 'email',
};

type Draft = { name: string; conditions: TriageConditions; actions: TriageActions };

/** "When from the API and mentions “crash”: priority Urgent, add Bug, assign in turn". */
function useSummary() {
  const ws = useWorkspace();
  const names = (ids?: string[]) =>
    (ids ?? []).map((id) => ws.labelById.get(id)?.name ?? 'label').join(', ');
  const people = (ids?: string[]) =>
    (ids ?? []).map((id) => ws.memberById.get(id)?.name.split(' ')[0] ?? 'someone').join(', ');
  return (r: Draft) => {
    const c = r.conditions;
    const when = [
      c.sources?.length && `from ${c.sources.map((s) => SOURCE_LABELS[s]).join(' or ')}`,
      c.text && `mentions “${c.text}”`,
      c.labelIds?.length && `labeled ${names(c.labelIds)}`,
      c.priorities?.length && `priority ${c.priorities.map(priorityLabel).join(' or ')}`,
    ].filter(Boolean);
    const a = r.actions;
    const then = [
      a.priority !== undefined && `priority ${priorityLabel(a.priority)}`,
      a.labelIds?.length && `add ${names(a.labelIds)}`,
      a.rotation?.length
        ? `assign in turn to ${people(a.rotation)}`
        : a.assigneeId && `assign ${people([a.assigneeId])}`,
      a.stateId && `accept into ${ws.stateById.get(a.stateId)?.name ?? 'a status'}`,
    ].filter(Boolean);
    return `${when.length ? `When ${when.join(' and ')}` : 'Always'}: ${then.join(', ') || 'nothing yet'}`;
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
    <Modal open onClose={onClose} width={600} label={rule ? 'Edit triage rule' : 'New triage rule'}>
      <form
        className="p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.name.trim()) return;
          save.mutate(clean(draft), { onSuccess: onClose });
        }}
      >
        <div className="section-label mb-3">{rule ? 'Edit triage rule' : 'New triage rule'}</div>
        <input
          className="input"
          placeholder="Rule name, e.g. Crashes are urgent"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />

        <div className="kicker mt-5 mb-1 text-[11px] uppercase tracking-[0.14em]">
          When an issue…
        </div>
        <div className={row}>
          <span className="text-index">comes from</span>
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
                {SOURCE_LABELS[s]}
              </label>
            ))}
          </span>
        </div>
        <div className={row}>
          <span className="text-index">mentions</span>
          <input
            className="input h-8"
            placeholder="text in title or description"
            value={draft.conditions.text ?? ''}
            onChange={(e) => cond({ text: e.target.value })}
          />
        </div>
        <div className={row}>
          <span className="text-index">has a label</span>
          <Picker
            multi
            placeholder="Labels…"
            options={labelOptions(ws, team.id)}
            selected={draft.conditions.labelIds ?? []}
            onSelect={(v) => cond({ labelIds: multi(draft.conditions.labelIds, v) })}
            trigger={chip(
              draft.conditions.labelIds?.length
                ? draft.conditions.labelIds.map((id) => ws.labelById.get(id)?.name).join(', ')
                : 'Any',
            )}
          />
        </div>
        <div className={row}>
          <span className="text-index">has priority</span>
          <Picker
            multi
            placeholder="Priorities…"
            options={priorityOptions()}
            selected={(draft.conditions.priorities ?? []).map(String)}
            onSelect={(v) =>
              cond({ priorities: multi(draft.conditions.priorities?.map(String), v).map(Number) })
            }
            trigger={chip(
              draft.conditions.priorities?.length
                ? draft.conditions.priorities.map(priorityLabel).join(', ')
                : 'Any',
            )}
          />
        </div>

        <div className="kicker mt-5 mb-1 text-[11px] uppercase tracking-[0.14em]">…then</div>
        <div className={row}>
          <span className="text-index">set priority</span>
          <select
            className="input h-8"
            value={draft.actions.priority ?? ''}
            onChange={(e) =>
              act({ priority: e.target.value === '' ? undefined : Number(e.target.value) })
            }
          >
            <option value="">Leave as is</option>
            {[1, 2, 3, 4, 0].map((p) => (
              <option key={p} value={p}>
                {priorityLabel(p)}
              </option>
            ))}
          </select>
        </div>
        <div className={row}>
          <span className="text-index">add labels</span>
          <Picker
            multi
            placeholder="Labels…"
            options={labelOptions(ws, team.id)}
            selected={draft.actions.labelIds ?? []}
            onSelect={(v) => act({ labelIds: multi(draft.actions.labelIds, v) })}
            trigger={chip(
              draft.actions.labelIds?.length
                ? draft.actions.labelIds.map((id) => ws.labelById.get(id)?.name).join(', ')
                : 'None',
            )}
          />
        </div>
        <div className={row}>
          <span className="text-index">assign</span>
          <Picker
            multi
            placeholder="One person, or several to take turns…"
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
                ? `In turn: ${draft.actions.rotation.map((id) => ws.memberById.get(id)?.name.split(' ')[0]).join(', ')}`
                : draft.actions.assigneeId
                  ? (ws.memberById.get(draft.actions.assigneeId)?.name ?? 'Someone')
                  : 'Nobody',
            )}
          />
        </div>
        <div className={row}>
          <span className="text-index">accept into</span>
          <select
            className="input h-8"
            value={draft.actions.stateId ?? ''}
            onChange={(e) => act({ stateId: e.target.value || undefined })}
          >
            <option value="">Keep in triage</option>
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
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!draft.name.trim() || save.isPending}>
            {rule ? 'Save' : 'Create rule'} <span className="arrow">→</span>
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
    <SettingsCard
      title="Triage rules"
      description="Applied in order to every issue that lands in triage; all matching rules apply. Changes are made by the Ordo bot, so each issue's history shows them."
    >
      {team.triageRules.map((r) => (
        <div key={r.id} className="flex items-center gap-3 border-b border-border-soft py-2">
          <input
            type="checkbox"
            className="accent-primary"
            checked={r.enabled}
            onChange={() => toggle.mutate(r)}
            aria-label={r.enabled ? `Disable ${r.name}` : `Enable ${r.name}`}
          />
          <div className={`min-w-0 flex-1 ${r.enabled ? '' : 'opacity-50'}`}>
            <div className="text-[13.5px]">{r.name}</div>
            <div className="truncate font-mono text-[11px] text-index">{summary(r)}</div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setEditing(r)}
            aria-label={`Edit ${r.name}`}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={async () => {
              if (await confirmDialog({ title: `Delete rule “${r.name}”?`, danger: true }))
                remove.mutate(r);
            }}
            aria-label={`Delete ${r.name}`}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={() => setEditing('new')}>
        <Plus size={13} /> Add rule
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
