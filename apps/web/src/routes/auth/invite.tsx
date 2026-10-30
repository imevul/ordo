import type { InvitePreview } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { keys, useMe } from '../../api/queries.ts';
import { Spinner } from '../../components/PageHeader.tsx';
import { t, tx } from '../../i18n/index.ts';

import { AuthLayout, ErrorLine, message } from './ui.tsx';

export function InvitePage() {
  const { token } = useParams({ from: '/invite/$token' });
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<InvitePreview>(`/invites/${token}`)
      .then(setInfo)
      .catch((err) => setError(message(err)));
  }, [token]);

  const accept = async () => {
    try {
      const res = await api.post<{ workspaceSlug: string }>(`/invites/${token}/accept`);
      qc.removeQueries({ queryKey: keys.me });
      navigate({ to: '/$slug', params: { slug: res.workspaceSlug } });
    } catch (err) {
      setError(message(err));
    }
  };

  if (me.isLoading) return <Spinner />;
  // An invite to the instance only: it makes a new account and joins no workspace.
  if (info?.kind === 'site') {
    return (
      <AuthLayout kicker={t('auth.invite.kicker')} title={t('auth.invite.titleSite')}>
        <ErrorLine error={error} />
        {me.data ? (
          <>
            <p className="mb-5 text-[13.5px] text-muted">
              {tx('auth.invite.alreadySignedUp', {
                email: me.data.email,
                b: (c) => <span className="text-text">{c}</span>,
              })}
            </p>
            <Link to="/" className="btn btn-primary w-full">
              {t('auth.invite.continue')} <span className="arrow">→</span>
            </Link>
          </>
        ) : (
          <>
            <p className="mb-5 text-[13.5px] text-muted">
              {info.canCreateWorkspaces ? t('auth.invite.siteCanCreate') : t('auth.invite.site')}
            </p>
            <Link to="/signup" search={{ invite: token }} className="btn btn-primary w-full">
              {t('auth.invite.createAccount')} <span className="arrow">→</span>
            </Link>
          </>
        )}
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      kicker={t('auth.invite.kicker')}
      title={
        info?.workspace
          ? t('auth.invite.title', { workspace: info.workspace.name })
          : t('auth.invite.titleLoading')
      }
    >
      <ErrorLine error={error} />
      {info?.role && (
        <p className="mb-4 text-[13px] text-muted">
          {tx(info.teams.length > 0 ? 'auth.invite.invitedAsTo' : 'auth.invite.invitedAs', {
            role: inviteRole(info.role),
            teams: info.teams.join(', '),
            b: (c) => <span className="text-text">{c}</span>,
          })}
        </p>
      )}
      {info && me.data && (
        <>
          <p className="mb-5 text-[13.5px] text-muted">
            {tx('auth.invite.signedInAs', {
              email: me.data.email,
              b: (c) => <span className="text-text">{c}</span>,
            })}
          </p>
          <button className="btn btn-primary w-full" onClick={accept}>
            {t('auth.invite.join')} <span className="arrow">→</span>
          </button>
        </>
      )}
      {info && !me.data && (
        <div className="flex flex-col gap-2">
          <Link to="/signup" search={{ invite: token }} className="btn btn-primary w-full">
            {t('auth.invite.createAccount')} <span className="arrow">→</span>
          </Link>
          <Link
            to="/login"
            search={{ redirect: `/invite/${token}` }}
            className="btn btn-ghost w-full"
          >
            {t('auth.invite.haveAccount')}
          </Link>
        </div>
      )}
    </AuthLayout>
  );
}

const INVITE_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
const inviteRole = (role: string) =>
  (INVITE_ROLES as readonly string[]).includes(role)
    ? t(`auth.invite.role.${role as (typeof INVITE_ROLES)[number]}`)
    : role;
