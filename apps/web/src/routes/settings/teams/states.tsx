import { LABEL_COLORS, type StateType, type Team, type WorkflowState } from '@ordo/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../../../api/client.ts';
import { useWsMutation } from '../../../api/queries.ts';
import { StatusIcon } from '../../../components/icons.tsx';
import { confirmDialog } from '../../../components/ui/Modal.tsx';
import { Popover } from '../../../components/ui/Popover.tsx';
import { t } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';

export function StateRow({ state, team }: { state: WorkflowState; team: Team }) {
  const ws = useWorkspace();
  const [name, setName] = useState(state.name);
  const save = useWsMutation(ws.slug, (body: object) =>
    api.patch(wsPath(ws.slug, `/states/${state.id}`), body),
  );
  const remove = useWsMutation(ws.slug, () => api.del(wsPath(ws.slug, `/states/${state.id}`)));
  const setDefault = useWsMutation(ws.slug, () =>
    api.patch(wsPath(ws.slug, `/teams/${team.id}`), { defaultStateId: state.id }),
  );
  const isDefault = team.defaultStateId === state.id;
  return (
    <div className="group flex h-10 items-center gap-3 border-b border-border-soft/60 pl-2">
      <Popover
        width={176}
        trigger={
          <button type="button" aria-label={t('teams.states.color')}>
            <StatusIcon type={state.type} color={state.color} />
          </button>
        }
      >
        {(close) => (
          <div className="grid grid-cols-6 gap-1.5 p-2.5">
            {LABEL_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className="h-5 w-5"
                style={{ background: c }}
                onClick={() => {
                  save.mutate({ color: c });
                  close();
                }}
                aria-label={c}
              />
            ))}
          </div>
        )}
      </Popover>
      <input
        className="h-8 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none focus:shadow-[inset_0_-1px_0_var(--color-primary)]"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== state.name && save.mutate({ name })}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        aria-label={t('teams.states.name')}
      />
      {isDefault ? (
        <span className="chip [--chip:var(--color-primary)]">{t('teams.states.default')}</span>
      ) : (
        state.type !== 'completed' &&
        state.type !== 'canceled' && (
          <button
            type="button"
            className="font-mono text-[10.5px] tracking-[0.1em] text-index uppercase opacity-0 group-hover:opacity-100 hover:text-text"
            onClick={() => setDefault.mutate(undefined)}
          >
            {t('teams.states.makeDefault')}
          </button>
        )
      )}
      <button
        type="button"
        className="btn btn-danger btn-sm opacity-0 group-hover:opacity-100"
        onClick={async () => {
          const ok = await confirmDialog({
            title: t('teams.states.deleteTitle', { name: state.name }),
            body: t('teams.states.deleteBody'),
            danger: true,
          });
          if (ok) remove.mutate(undefined);
        }}
        aria-label={t('teams.states.deleteLabel', { name: state.name })}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

export function AddState({ team, type }: { team: Team; type: StateType }) {
  const ws = useWorkspace();
  const [name, setName] = useState('');
  const add = useWsMutation(ws.slug, (body: object) =>
    api.post(wsPath(ws.slug, `/teams/${team.id}/states`), body),
  );
  return (
    <form
      className="flex h-9 items-center gap-2 pl-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        add.mutate(
          { name, type, color: team.states.find((s) => s.type === type)?.color ?? '#b8aab2' },
          { onSuccess: () => setName('') },
        );
      }}
    >
      <Plus size={13} className="text-index" />
      <input
        className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-index"
        placeholder={t(`teams.states.add.${type}`)}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
    </form>
  );
}
