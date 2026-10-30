import { type JoinableWorkspace, SLUG_PATTERN, TEAM_KEY_PATTERN } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client.ts';
import { keys, useMe } from '../../api/queries.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { t, tx } from '../../i18n/index.ts';

import { AuthLayout, ErrorLine, message, TextField } from './ui.tsx';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
const keyify = (s: string) => {
  const words = s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const k = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3);
  return k.replace(/^[0-9]+/, '').slice(0, 5);
};

export function OnboardingPage() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [teamName, setTeamName] = useState(() => t('auth.onboarding.defaultTeam'));
  const [teamKey, setTeamKey] = useState(() => keyify(t('auth.onboarding.defaultTeam')) || 'ENG');
  const [keyTouched, setKeyTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Workspaces this person may join through their verified email domain.
  const joinable = useQuery({
    queryKey: ['joinable'],
    queryFn: () => api.get<JoinableWorkspace[]>('/workspaces/joinable'),
    enabled: !!me.data,
  });

  if (me.isLoading) return <Spinner />;
  if (!me.data) return <Navigate to="/login" search={{ redirect: '/onboarding' }} />;

  const join = async (id: string) => {
    try {
      const res = await api.post<{ workspaceSlug: string }>(`/workspaces/${id}/join`);
      qc.removeQueries({ queryKey: keys.me });
      navigate({ to: '/$slug', params: { slug: res.workspaceSlug } });
    } catch (err) {
      setError(message(err));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!SLUG_PATTERN.test(slug)) return setError(t('auth.onboarding.slugInvalid'));
    if (!TEAM_KEY_PATTERN.test(teamKey)) return setError(t('auth.onboarding.teamKeyInvalid'));
    try {
      const res = await api.post<{ slug: string }>('/workspaces', {
        name,
        slug,
        teamName,
        teamKey,
      });
      qc.removeQueries({ queryKey: keys.me });
      navigate({ to: '/$slug', params: { slug: res.slug } });
    } catch (err) {
      setError(message(err));
    }
  };

  const joinList = joinable.data && joinable.data.length > 0 && (
    <div className="mb-6">
      <div className="mb-2 font-mono text-[10.5px] font-semibold tracking-[0.16em] text-muted uppercase">
        {t('auth.onboarding.orJoin')}
      </div>
      {joinable.data.map((w) => (
        <button
          type="button"
          key={w.id}
          onClick={() => join(w.id)}
          className="panel panel-sm panel-interactive mb-2 flex w-full items-center gap-3 p-3 text-left"
        >
          {w.logoUrl && <img src={w.logoUrl} alt="" className="h-6 w-6 object-cover" />}
          <span className="min-w-0 flex-1 truncate">{w.name}</span>
          <span className="font-mono text-[11px] whitespace-nowrap text-index">
            {t('auth.onboarding.members', { count: w.memberCount })}
          </span>
          <span className="arrow text-primary">→</span>
        </button>
      ))}
    </div>
  );

  // Not allowed to make one (e.g. site-invited without the grant): wait to be added instead.
  if (!me.data.canCreateWorkspace) {
    if (me.data.workspaces[0])
      return <Navigate to="/$slug" params={{ slug: me.data.workspaces[0].slug }} />;
    return (
      <AuthLayout kicker={t('auth.onboarding.waitKicker')} title={t('auth.onboarding.waitTitle')}>
        <ErrorLine error={error} />
        {joinList}
        <p className="mb-5 text-[13.5px] text-muted">{t('auth.onboarding.waitBody')}</p>
        <button
          type="button"
          className="btn btn-ghost w-full"
          onClick={() => {
            me.refetch();
            joinable.refetch();
          }}
        >
          {t('auth.onboarding.checkAgain')}
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout kicker={t('auth.onboarding.kicker')} title={t('auth.onboarding.title')}>
      {joinList}
      <form onSubmit={submit}>
        <ErrorLine error={error} />
        <TextField
          label={t('auth.onboarding.workspaceName')}
          required
          autoFocus
          value={name}
          placeholder="Acme Inc."
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
        />
        <label className="mb-4 block">
          <span className="mb-1 block font-mono text-[10.5px] font-semibold tracking-[0.16em] text-muted uppercase">
            {t('auth.onboarding.workspaceUrl')}
          </span>
          <div className="flex items-center border border-border bg-bg focus-within:border-primary">
            <span className="pl-3 font-mono text-[12px] text-index">{location.host}/</span>
            <input
              className="h-9 min-w-0 flex-1 bg-transparent pr-3 outline-none"
              required
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
            />
          </div>
        </label>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <TextField
            label={t('auth.onboarding.firstTeam')}
            required
            value={teamName}
            onChange={(e) => {
              setTeamName(e.target.value);
              if (!keyTouched) setTeamKey(keyify(e.target.value));
            }}
          />
          <TextField
            label={t('auth.onboarding.key')}
            required
            value={teamKey}
            maxLength={7}
            onChange={(e) => {
              setKeyTouched(true);
              setTeamKey(e.target.value.toUpperCase());
            }}
          />
        </div>
        <p className="-mt-2 mb-5 text-[12px] text-index">
          {tx('auth.onboarding.identifiers', {
            id: `${teamKey || 'KEY'}-1`,
            code: (c) => <span className="font-mono text-muted">{c}</span>,
          })}
        </p>
        <button className="btn btn-primary w-full">
          {t('auth.onboarding.submit')} <span className="arrow">→</span>
        </button>
      </form>
    </AuthLayout>
  );
}
