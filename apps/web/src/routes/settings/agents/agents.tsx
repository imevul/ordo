import type { Agent } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Power } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { keys as queryKeys } from '../../../api/queries.ts';
import { TeamIcon } from '../../../components/icons.tsx';
import { Spinner } from '../../../components/PageHeader.tsx';
import { Avatar } from '../../../components/ui/Avatar.tsx';
import { confirmDialog } from '../../../components/ui/Modal.tsx';
import { t, tx } from '../../../i18n/index.ts';
import { relativeTime, usd } from '../../../lib/format.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';
import { AgentModal } from './agent-modal.tsx';
import { KeyModal, TokenModal } from './keys.tsx';
import { AgentSchedules } from './schedules.tsx';
import { errMsg } from './shared.ts';

/** Settings → Agents: who they are, which teams they work in, and the keys their runners use. */
export function AgentsSection() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'agents'];
  const { data: agents } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Agent[]>(wsPath(ws.slug, '/agents')),
    enabled: ws.isAdmin,
  });
  const [editing, setEditing] = useState<Agent | 'new' | null>(null);
  const [keyFor, setKeyFor] = useState<Agent | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const reload = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: queryKeys.bootstrap(ws.slug) });
  };

  if (!ws.isAdmin) return <p className="text-muted">{t('agents.adminsOnly')}</p>;
  if (!agents) return <Spinner />;

  return (
    <>
      <SettingsCard
        title={t('agents.title')}
        description={tx('agents.description', {
          command: <code className="font-mono text-text">ordo agent run</code>,
        })}
      >
        {agents.map((a) => (
          <div key={a.id} className="border-b border-border-soft py-3">
            <div className="flex items-center gap-3">
              <Avatar name={a.name} color={a.avatarColor} size={22} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13.5px]">
                  <span className={a.disabled ? 'text-index line-through' : ''}>{a.name}</span>
                  <span className="font-mono text-[11.5px] text-index">@{a.username}</span>
                  {a.disabled && <span className="tag font-mono">{t('agents.disabled')}</span>}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-index">
                  {a.teamIds.length === 0 && t('agents.noTeams')}
                  {a.teamIds.map((id) => {
                    const team = ws.teamById.get(id);
                    return team ? (
                      <span key={id} className="inline-flex items-center gap-1">
                        <TeamIcon color={team.color} label={team.key} size={12} /> {team.key}
                      </span>
                    ) : null;
                  })}
                  <span>· {t('agents.keyCount', { count: a.keys.length })}</span>
                  <span className="font-mono">
                    ·{' '}
                    {a.monthlyBudgetUsd !== null
                      ? t('agents.spentOfBudget', {
                          cost: usd(a.monthCostUsd),
                          budget: usd(a.monthlyBudgetUsd),
                        })
                      : t('agents.spent', { cost: usd(a.monthCostUsd) })}
                  </span>
                  {a.pauseReason === 'budget' && (
                    <span className="tag font-mono text-warning">{t('agents.budgetPaused')}</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={a.disabled}
                onClick={() => setKeyFor(a)}
              >
                <KeyRound size={12} /> {t('agents.newKey')}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t('agents.edit', { name: a.name })}
                onClick={() => setEditing(a)}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className={`btn btn-sm ${a.disabled ? 'btn-ghost' : 'btn-danger'}`}
                title={a.disabled ? t('agents.enable') : t('agents.disable')}
                aria-label={a.disabled ? t('agents.enable') : t('agents.disable')}
                onClick={async () => {
                  if (
                    !a.disabled &&
                    !(await confirmDialog({
                      title: t('agents.confirmDisable', { name: a.name }),
                      danger: true,
                    }))
                  )
                    return;
                  try {
                    await api.patch(wsPath(ws.slug, `/agents/${a.id}`), { disabled: !a.disabled });
                    reload();
                  } catch (err) {
                    toast.error(errMsg(err));
                  }
                }}
              >
                <Power size={12} />
              </button>
            </div>
            {a.keys.length > 0 && (
              <div className="mt-2 ml-[34px]">
                {a.keys.map((k) => (
                  <div key={k.id} className="flex items-center gap-2 py-0.5 text-[12px]">
                    <KeyRound size={11} className="flex-none text-index" />
                    <span className="min-w-0 flex-1 truncate">
                      {k.name}{' '}
                      <span className="font-mono text-index">
                        {k.lastUsedAt
                          ? t('agents.keys.used', {
                              prefix: k.prefix,
                              time: relativeTime(k.lastUsedAt),
                            })
                          : t('agents.keys.unused', { prefix: k.prefix })}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        if (
                          !(await confirmDialog({
                            title: t('agents.keys.confirmRevoke', { name: k.name }),
                            danger: true,
                          }))
                        )
                          return;
                        await api.del(wsPath(ws.slug, `/agents/${a.id}/keys/${k.id}`));
                        reload();
                      }}
                    >
                      {t('agents.keys.revoke')}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <AgentSchedules agentId={a.id} />
          </div>
        ))}
        {agents.length === 0 && (
          <p className="font-mono text-[12px] text-index">{t('agents.empty')}</p>
        )}
        <button type="button" className="btn btn-primary mt-4" onClick={() => setEditing('new')}>
          <Plus size={13} /> {t('agents.add')}
        </button>
      </SettingsCard>

      <AgentModal
        agent={editing}
        onClose={() => setEditing(null)}
        onSaved={(created) => {
          setEditing(null);
          reload();
          // A new agent needs a key before anything can run for it.
          if (created) setKeyFor(created);
        }}
      />
      <KeyModal
        agent={keyFor}
        onClose={() => setKeyFor(null)}
        onCreated={(value) => {
          setKeyFor(null);
          setToken(value);
          reload();
        }}
      />
      <TokenModal token={token} onClose={() => setToken(null)} />
    </>
  );
}
