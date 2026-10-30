import { Link, Navigate, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useMe } from '../../api/queries.ts';
import { OrdoMark } from '../../components/icons.tsx';
import { PageHeader, Sep, Spinner } from '../../components/PageHeader.tsx';
import { t } from '../../i18n/index.ts';
import { Audit } from './audit.tsx';
import { Domains } from './domains.tsx';
import { Invites } from './invites.tsx';
import { Jobs } from './jobs.tsx';
import { Overview } from './overview.tsx';
import { Settings } from './settings.tsx';
import { Users } from './users.tsx';
import { Workspaces } from './workspaces.tsx';

/**
 * The instance administrator's area: every user and workspace on this Ordo, instance settings,
 * background jobs and health. Lives outside any workspace.
 */

const SECTIONS = [
  'overview',
  'users',
  'invites',
  'workspaces',
  'domains',
  'settings',
  'jobs',
  'audit',
] as const;
type Section = (typeof SECTIONS)[number];
const sectionLabel = (s: Section) => t(`admin.sections.${s}`);

export function AdminPage() {
  const { section } = useParams({ from: '/admin/$section' });
  const me = useMe();
  if (me.isLoading) return <Spinner label={t('auth.booting')} />;
  if (!me.data) return <Navigate to="/login" search={{ redirect: `/admin/${section}` }} />;
  if (!me.data.isInstanceAdmin) return <Navigate to="/" />;
  const current = SECTIONS.find((s) => s === section) ?? SECTIONS[0];
  const back = me.data.workspaces[0];

  return (
    <div className="flex h-full">
      <nav
        className="hidden w-56 flex-none flex-col border-r border-border-soft bg-surface p-3 md:flex"
        aria-label={t('admin.navLabel')}
      >
        <div className="mb-6 flex h-9 items-center px-2">
          <OrdoMark />
          <span className="ml-2 font-mono text-[10.5px] tracking-[0.16em] text-primary uppercase">
            {t('admin.brand')}
          </span>
        </div>
        {SECTIONS.map((s) => (
          <Link
            key={s}
            to="/admin/$section"
            params={{ section: s }}
            className={`nav-item ${s === current ? 'active' : ''}`}
          >
            {sectionLabel(s)}
          </Link>
        ))}
        {back && (
          <Link to="/$slug" params={{ slug: back.slug }} className="nav-item mt-auto">
            <ArrowLeft size={14} />
            <span className="min-w-0 truncate">{t('admin.backTo', { name: back.name })}</span>
          </Link>
        )}
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          kicker={
            <>
              {t('admin.kicker')}
              <Sep />
              {sectionLabel(current)}
            </>
          }
          title={sectionLabel(current)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-6 py-8">
            {current === 'overview' && <Overview />}
            {current === 'users' && <Users myId={me.data.id} />}
            {current === 'invites' && <Invites />}
            {current === 'workspaces' && <Workspaces />}
            {current === 'domains' && <Domains />}
            {current === 'settings' && <Settings />}
            {current === 'jobs' && <Jobs />}
            {current === 'audit' && <Audit />}
          </div>
        </div>
      </main>
    </div>
  );
}
