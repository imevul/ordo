import { CHAT_EVENT_KINDS, type ChatChannel, type ChatEventKind } from '@ordo/shared';
import { Plus, Trash2 } from 'lucide-react';
import { t, tx } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { TeamSelect } from '../ui.tsx';

function eventLabel(kind: ChatEventKind) {
  switch (kind) {
    case 'issue.created':
      return t('integrations.chat.events.issueCreated');
    case 'issue.status':
      return t('integrations.chat.events.issueStatus');
    case 'issue.completed':
      return t('integrations.chat.events.issueCompleted');
    case 'comment.created':
      return t('integrations.chat.events.commentCreated');
    case 'project_update.created':
      return t('integrations.chat.events.projectUpdateCreated');
  }
}

const emptyChannel = (): ChatChannel => ({
  id: '',
  name: '',
  teamIds: [],
  events: ['issue.created', 'issue.completed'],
  defaultTeamId: null,
});

/** Channels and what each one hears about. */
export function ChannelsEditor({
  value,
  onChange,
  hint,
}: {
  value: ChatChannel[];
  onChange: (v: ChatChannel[]) => void;
  hint: string;
}) {
  const ws = useWorkspace();
  const teams = [...ws.teamById.values()];
  const set = (i: number, patch: Partial<ChatChannel>) =>
    onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const toggle = <T,>(list: T[], item: T) =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
  return (
    <div className="mb-4">
      <div className="mb-1 text-[12px] text-muted">{t('integrations.chat.channels')}</div>
      <p className="mb-2 text-[11.5px] text-index">{hint}</p>
      {value.map((c, i) => (
        <div key={i} className="mb-2 border border-border-soft bg-bg p-3">
          <div className="mb-2 flex gap-2">
            <input
              className="input flex-1 font-mono"
              placeholder={t('integrations.chat.channelId')}
              aria-label={t('integrations.chat.channelId')}
              required
              value={c.id}
              onChange={(e) => set(i, { id: e.target.value })}
            />
            <input
              className="input w-36"
              placeholder={t('integrations.chat.channelNamePlaceholder')}
              aria-label={t('integrations.chat.channelName')}
              value={c.name ?? ''}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t('integrations.chat.removeChannel')}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
            {CHAT_EVENT_KINDS.map((k) => (
              <label key={k} className="flex items-center gap-1.5 text-[12.5px]">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={c.events.includes(k)}
                  onChange={() => set(i, { events: toggle(c.events, k) })}
                />
                {eventLabel(k)}
              </label>
            ))}
          </div>
          <div className="mb-1 text-[11.5px] text-index">
            {c.teamIds.length
              ? t('integrations.chat.fromTeams')
              : t('integrations.chat.fromPublicTeams')}
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {teams.map((team) => (
              <button
                key={team.id}
                type="button"
                className={`tag font-mono ${c.teamIds.includes(team.id) ? 'border-primary text-text' : ''}`}
                aria-pressed={c.teamIds.includes(team.id)}
                onClick={() => set(i, { teamIds: toggle(c.teamIds, team.id) })}
              >
                {team.key}
                {team.private && ` · ${t('integrations.chat.private')}`}
              </button>
            ))}
          </div>
          <label className="mb-2 flex items-start gap-1.5 text-[12.5px]">
            <input
              type="checkbox"
              className="mt-0.5 accent-primary"
              checked={c.threads !== false}
              onChange={(e) => set(i, { threads: e.target.checked })}
            />
            <span>
              {t('integrations.chat.threads')}
              <span className="block text-[11.5px] text-index">
                {t('integrations.chat.threadsHint')}
              </span>
            </span>
          </label>
          <label className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            {tx('integrations.chat.newIssuesGoTo', {
              select: (
                <TeamSelect
                  className="input h-7 w-auto min-w-0 max-w-full py-0 text-[12px]"
                  none={t('integrations.chat.defaultTeam')}
                  value={c.defaultTeamId}
                  onChange={(defaultTeamId) => set(i, { defaultTeamId })}
                />
              ),
            })}
          </label>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => onChange([...value, emptyChannel()])}
      >
        <Plus size={12} /> {t('integrations.chat.addChannel')}
      </button>
    </div>
  );
}
