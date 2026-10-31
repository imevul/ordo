import { type Agent, AVATAR_COLORS } from '@ordo/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../../api/client.ts';
import { TeamIcon } from '../../../components/icons.tsx';
import { MarkdownEditor } from '../../../components/MarkdownEditor.tsx';
import { Avatar } from '../../../components/ui/Avatar.tsx';
import { AvatarColorPicker } from '../../../components/ui/AvatarColorPicker.tsx';
import { Modal } from '../../../components/ui/Modal.tsx';
import { t } from '../../../i18n/index.ts';
import { usd } from '../../../lib/format.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { FormRow } from '../ui.tsx';
import { errMsg } from './shared.ts';

const toggle = <T,>(list: T[], v: T) =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

export function AgentModal({
  agent,
  onClose,
  onSaved,
}: {
  agent: Agent | 'new' | null;
  onClose: () => void;
  onSaved: (created?: Agent) => void;
}) {
  const ws = useWorkspace();
  const existing = agent && agent !== 'new' ? agent : null;
  const [name, setName] = useState('');
  const [avatarColor, setAvatarColor] = useState(AVATAR_COLORS[0]!);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [instructions, setInstructions] = useState('');
  const [concurrency, setConcurrency] = useState(1);
  const [followPullRequests, setFollowPullRequests] = useState(true);
  const [waitForBlockers, setWaitForBlockers] = useState(true);
  // As typed; empty is no budget.
  const [budget, setBudget] = useState('');
  const [requirePlanApproval, setRequirePlanApproval] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!agent) return;
    setName(existing?.name ?? '');
    setAvatarColor(
      existing?.avatarColor ?? AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!,
    );
    setTeamIds(existing?.teamIds ?? (ws.teams[0] ? [ws.teams[0].id] : []));
    setInstructions(existing?.instructions ?? '');
    setConcurrency(existing?.concurrency ?? 1);
    setFollowPullRequests(existing?.followPullRequests ?? true);
    setWaitForBlockers(existing?.waitForBlockers ?? true);
    setBudget(existing?.monthlyBudgetUsd != null ? String(existing.monthlyBudgetUsd) : '');
    setRequirePlanApproval(existing?.requirePlanApproval ?? false);
  }, [agent, existing, ws.teams]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (teamIds.length === 0) {
      toast.error(t('agents.form.pickTeam'));
      return;
    }
    const monthlyBudgetUsd = budget.trim() ? Number(budget) : null;
    if (monthlyBudgetUsd !== null && !(monthlyBudgetUsd > 0)) {
      toast.error(t('agents.form.budgetInvalid'));
      return;
    }
    setBusy(true);
    const body = {
      name,
      avatarColor,
      teamIds,
      instructions,
      concurrency,
      followPullRequests,
      waitForBlockers,
      monthlyBudgetUsd,
      requirePlanApproval,
    };
    try {
      if (existing) {
        await api.patch(wsPath(ws.slug, `/agents/${existing.id}`), body);
        onSaved();
      } else onSaved(await api.post<Agent>(wsPath(ws.slug, '/agents'), body));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!agent}
      onClose={onClose}
      width={620}
      label={t('agents.form.label')}
      align="center"
    >
      <form className="max-h-[82vh] overflow-y-auto p-6" onSubmit={submit}>
        <div className="section-label mb-4">
          {existing ? t('agents.form.edit') : t('agents.form.new')}
        </div>
        <FormRow label={t('agents.form.name')}>
          <input
            className="input"
            required
            autoFocus
            maxLength={120}
            placeholder={t('agents.form.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </FormRow>
        <FormRow label={t('agents.form.color')}>
          <div className="flex items-center gap-3">
            <Avatar name={name || '?'} color={avatarColor} size={22} />
            <AvatarColorPicker
              value={avatarColor}
              onChange={setAvatarColor}
              label={t('agents.form.color')}
            />
          </div>
        </FormRow>
        <div className="mb-1 text-[12px] text-muted">{t('agents.form.teams')}</div>
        <div className="mb-1 flex flex-wrap gap-3 border border-border-soft p-3">
          {ws.teams.map((team) => (
            <label key={team.id} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="accent-primary"
                checked={teamIds.includes(team.id)}
                onChange={() => setTeamIds(toggle(teamIds, team.id))}
              />
              <TeamIcon color={team.color} label={team.key} size={14} /> {team.name}
            </label>
          ))}
        </div>
        <p className="mb-4 text-[11.5px] text-index">{t('agents.form.teamsHint')}</p>
        <div className="mb-1 text-[12px] text-muted">{t('agents.form.instructions')}</div>
        <MarkdownEditor
          value={instructions}
          onChange={setInstructions}
          minRows={5}
          placeholder={t('agents.form.instructionsPlaceholder')}
        />
        <p className="mt-1 mb-4 text-[11.5px] text-index">{t('agents.form.instructionsHint')}</p>
        <FormRow label={t('agents.form.concurrency')} hint={t('agents.form.concurrencyHint')}>
          <input
            className="input w-24"
            type="number"
            min={1}
            max={20}
            value={concurrency}
            onChange={(e) => setConcurrency(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
          />
        </FormRow>
        <FormRow
          label={t('agents.form.budget')}
          hint={
            existing
              ? t('agents.form.budgetSpent', { cost: usd(existing.monthCostUsd) })
              : t('agents.form.budgetHint')
          }
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] text-index">$</span>
            <input
              className="input w-28"
              type="number"
              min={0.01}
              step={0.01}
              inputMode="decimal"
              placeholder={t('agents.form.budgetNone')}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
        </FormRow>
        <label className="mt-4 flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={followPullRequests}
            onChange={(e) => setFollowPullRequests(e.target.checked)}
          />
          <span>
            {t('agents.form.followPullRequests')}
            <span className="block text-[11.5px] text-index">
              {t('agents.form.followPullRequestsHint')}
            </span>
          </span>
        </label>
        <label className="mt-3 flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={waitForBlockers}
            onChange={(e) => setWaitForBlockers(e.target.checked)}
          />
          <span>
            {t('agents.form.waitForBlockers')}
            <span className="block text-[11.5px] text-index">
              {t('agents.form.waitForBlockersHint')}
            </span>
          </span>
        </label>
        <label className="mt-3 flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={requirePlanApproval}
            onChange={(e) => setRequirePlanApproval(e.target.checked)}
          />
          <span>
            {t('agents.form.requirePlanApproval')}
            <span className="block text-[11.5px] text-index">
              {t('agents.form.requirePlanApprovalHint')}
            </span>
          </span>
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {existing ? t('common.save') : t('agents.add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
