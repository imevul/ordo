import { LABEL_COLORS, type Label } from '@ordo/shared';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../../api/client.ts';
import { useWsMutation } from '../../api/queries.ts';
import { confirmDialog } from '../../components/ui/Modal.tsx';
import { Popover } from '../../components/ui/Popover.tsx';
import { t } from '../../i18n/index.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { SettingsCard, TeamSelect } from './ui.tsx';

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <Popover
      width={176}
      trigger={
        <button
          type="button"
          className="h-5 w-5 flex-none"
          style={{ background: value }}
          aria-label={t('settings.labels.changeColor')}
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
        aria-label={t('settings.labels.name')}
      />
      <span className="tag font-mono">{team ? team.key : t('settings.labels.workspaceTag')}</span>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={async () => {
          if (
            await confirmDialog({
              title: t('settings.labels.deleteTitle', { name: label.name }),
              danger: true,
            })
          )
            remove.mutate(undefined);
        }}
        aria-label={t('settings.labels.deleteLabel', { name: label.name })}
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
    <SettingsCard title={t('settings.labels.title')} description={t('settings.labels.description')}>
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
          placeholder={t('settings.labels.newLabel')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TeamSelect
          className="input w-36"
          none={t('settings.labels.workspace')}
          value={teamId}
          onChange={(id) => setTeamId(id ?? '')}
          aria-label={t('settings.labels.scope')}
        />
        <button className="btn btn-primary">{t('common.add')}</button>
      </form>
      {ws.labels.map((l) => (
        <LabelRow key={l.id} label={l} />
      ))}
      {ws.labels.length === 0 && (
        <p className="font-mono text-[12px] text-index">{t('settings.labels.empty')}</p>
      )}
    </SettingsCard>
  );
}
