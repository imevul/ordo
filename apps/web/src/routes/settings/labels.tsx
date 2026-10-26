import { LABEL_COLORS, type Label } from '@ordo/shared';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../../api/client.ts';
import { useWsMutation } from '../../api/queries.ts';
import { Popover } from '../../components/ui/Popover.tsx';
import { useWorkspace } from '../../lib/workspace.tsx';
import { SettingsCard } from './index.tsx';

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <Popover
      width={176}
      trigger={
        <button
          type="button"
          className="h-5 w-5 flex-none"
          style={{ background: value }}
          aria-label="Change color"
        />
      }
    >
      {(close) => (
        <div className="grid grid-cols-6 gap-1.5 p-2.5">
          {LABEL_COLORS.map((c) => (
            <button
              type="button"
              key={c}
              className={`h-5 w-5 ${c === value ? 'outline-2 outline-offset-2 outline-text' : ''}`}
              style={{ background: c }}
              onClick={() => {
                onChange(c);
                close();
              }}
              aria-label={c}
            />
          ))}
        </div>
      )}
    </Popover>
  );
}

function LabelRow({ label }: { label: Label }) {
  const ws = useWorkspace();
  const [name, setName] = useState(label.name);
  const save = useWsMutation(ws.slug, (body: object) =>
    api.patch(wsPath(ws.slug, `/labels/${label.id}`), body),
  );
  const remove = useWsMutation(ws.slug, () => api.del(wsPath(ws.slug, `/labels/${label.id}`)));
  const team = label.teamId ? ws.teamById.get(label.teamId) : null;
  return (
    <div className="flex h-11 items-center gap-3 border-b border-border-soft">
      <ColorPicker value={label.color} onChange={(color) => save.mutate({ color })} />
      <input
        className="h-8 min-w-0 flex-1 bg-transparent outline-none focus:shadow-[inset_0_-1px_0_var(--color-primary)]"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== label.name && save.mutate({ name })}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        aria-label="Label name"
      />
      <span className="tag font-mono">{team ? team.key : 'workspace'}</span>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={() => confirm(`Delete label “${label.name}”?`) && remove.mutate(undefined)}
        aria-label={`Delete ${label.name}`}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

export function LabelsSection() {
  const ws = useWorkspace();
  const [name, setName] = useState('');
  const [color, setColor] = useState(LABEL_COLORS[0]!);
  const [teamId, setTeamId] = useState('');
  const create = useWsMutation(ws.slug, (body: object) =>
    api.post(wsPath(ws.slug, '/labels'), body),
  );
  return (
    <SettingsCard
      title="Labels"
      description="Workspace labels are available to every team; team labels only to that team."
    >
      <form
        className="mb-5 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          create.mutate({ name, color, teamId: teamId || null }, { onSuccess: () => setName('') });
        }}
      >
        <ColorPicker value={color} onChange={setColor} />
        <input
          className="input min-w-0 flex-1"
          placeholder="New label"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className="input w-36"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          aria-label="Scope"
        >
          <option value="">Workspace</option>
          {ws.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button className="btn btn-primary">Add</button>
      </form>
      {ws.labels.map((l) => (
        <LabelRow key={l.id} label={l} />
      ))}
      {ws.labels.length === 0 && (
        <p className="font-mono text-[12px] text-index">// no labels yet</p>
      )}
    </SettingsCard>
  );
}
