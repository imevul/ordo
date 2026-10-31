import { LABEL_COLORS, type Team } from '@ordo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { Lock, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, wsPath } from '../../../api/client.ts';
import { useWsMutation } from '../../../api/queries.ts';
import { TeamIcon } from '../../../components/icons.tsx';
import { t } from '../../../i18n/index.ts';
import { useWorkspace } from '../../../lib/workspace.tsx';
import { SettingsCard } from '../ui.tsx';

export function TeamsSection() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const create = useWsMutation(
    ws.slug,
    (body: object) => api.post<Team>(wsPath(ws.slug, '/teams'), body),
    { success: t('teams.create.created') },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        name,
        key,
        private: isPrivate,
        color: LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)],
      },
      {
        onSuccess: (team) =>
          navigate({ to: '/$slug/settings/team/$key', params: { slug: ws.slug, key: team.key } }),
      },
    );
  };
  return (
    <>
      <SettingsCard title={t('teams.list.title')} description={t('teams.list.description')}>
        {ws.teams.map((team) => (
          <Link
            key={team.id}
            to="/$slug/settings/team/$key"
            params={{ slug: ws.slug, key: team.key }}
            className="row flex h-11 items-center gap-3 border-b border-border-soft px-1"
          >
            <TeamIcon color={team.color} label={team.key} />
            <span className="min-w-0 flex-1 truncate">{team.name}</span>
            {team.private && (
              <span className="tag">
                <Lock size={11} /> {t('teams.list.private')}
              </span>
            )}
            <span className="tag font-mono">{team.key}</span>
            <span className="font-mono text-[11px] whitespace-nowrap text-index">
              {t('teams.list.memberCount', { count: team.memberIds.length })}
            </span>
          </Link>
        ))}
      </SettingsCard>
      {!ws.isGuest && (
        <SettingsCard title={t('teams.create.title')}>
          <form onSubmit={submit} className="grid grid-cols-[1fr_7rem_auto] gap-2">
            <input
              className="input"
              placeholder={t('teams.create.namePlaceholder')}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setKey(
                  e.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, '')
                    .slice(0, 3),
                );
              }}
              required
            />
            <input
              className="input font-mono"
              placeholder={t('teams.create.keyPlaceholder')}
              value={key}
              maxLength={7}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              required
            />
            <button className="btn btn-primary">
              <Plus size={13} /> {t('common.create')}
            </button>
            <label className="col-span-3 flex items-center gap-2 text-[13px] text-muted">
              <input
                type="checkbox"
                className="accent-primary"
                checked={isPrivate}
                onChange={(e) => setPrivate(e.target.checked)}
              />
              {t('teams.create.private')}
            </label>
          </form>
        </SettingsCard>
      )}
    </>
  );
}
