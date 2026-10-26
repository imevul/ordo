import { Link, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { TeamIcon } from '../../components/icons.tsx';
import { PageHeader, Sep } from '../../components/PageHeader.tsx';
import { useWorkspace } from '../../lib/workspace.tsx';
import {
  AccountSection,
  ApiKeysSection,
  NotificationsSection,
  SecuritySection,
} from './account.tsx';
import { LabelsSection } from './labels.tsx';
import { AuthenticationSection } from './sso.tsx';
import { TeamSettings, TeamsSection } from './teams.tsx';
import { WebhooksSection } from './webhooks.tsx';
import {
  AuditSection,
  MembersSection,
  OrgSecuritySection,
  WorkspaceSection,
} from './workspace.tsx';

const SECTIONS: { key: string; label: string; group: string; admin?: boolean }[] = [
  { key: 'account', label: 'Profile', group: 'Account' },
  { key: 'security', label: 'Security', group: 'Account' },
  { key: 'notifications', label: 'Notifications', group: 'Account' },
  { key: 'api', label: 'API keys', group: 'Account' },
  { key: 'workspace', label: 'General', group: 'Workspace', admin: true },
  { key: 'members', label: 'Members', group: 'Workspace' },
  { key: 'teams', label: 'Teams', group: 'Workspace' },
  { key: 'labels', label: 'Labels', group: 'Workspace' },
  { key: 'org-security', label: 'Security', group: 'Workspace', admin: true },
  { key: 'authentication', label: 'Authentication', group: 'Workspace', admin: true },
  { key: 'webhooks', label: 'Webhooks', group: 'Workspace', admin: true },
  { key: 'audit', label: 'Audit log', group: 'Workspace', admin: true },
];

function SettingsShell({
  active,
  title,
  children,
}: {
  active: string;
  title: string;
  children: ReactNode;
}) {
  const ws = useWorkspace();
  const groups = [...new Set(SECTIONS.map((s) => s.group))];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={
          <>
            settings
            <Sep />
            {active}
          </>
        }
        title={title}
      />
      <div className="flex min-h-0 flex-1">
        <nav
          className="hidden w-52 flex-none overflow-y-auto border-r border-border-soft p-3 md:block"
          aria-label="Settings"
        >
          {groups.map((g) => (
            <div key={g} className="mb-4">
              <div className="mb-1 px-2 font-mono text-[10.5px] font-semibold tracking-[0.2em] text-index uppercase">
                {g}
              </div>
              {SECTIONS.filter((s) => s.group === g && (!s.admin || ws.isAdmin)).map((s) => (
                <Link
                  key={s.key}
                  to="/$slug/settings/$section"
                  params={{ slug: ws.slug, section: s.key }}
                  className={`nav-item ${active === s.key ? 'active' : ''}`}
                >
                  {s.label}
                </Link>
              ))}
            </div>
          ))}
          <div className="mb-1 px-2 font-mono text-[10.5px] font-semibold tracking-[0.2em] text-index uppercase">
            Your teams
          </div>
          {ws.teams.map((t) => (
            <Link
              key={t.id}
              to="/$slug/settings/team/$key"
              params={{ slug: ws.slug, key: t.key }}
              className={`nav-item ${active === `team:${t.key}` ? 'active' : ''}`}
            >
              <TeamIcon color={t.color} label={t.key} size={14} /> {t.name}
            </Link>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-6 py-8">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { section } = useParams({ from: '/$slug/settings/$section' });
  const meta = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0]!;
  const body =
    section === 'api' ? (
      <ApiKeysSection />
    ) : section === 'security' ? (
      <SecuritySection />
    ) : section === 'notifications' ? (
      <NotificationsSection />
    ) : section === 'workspace' ? (
      <WorkspaceSection />
    ) : section === 'members' ? (
      <MembersSection />
    ) : section === 'org-security' ? (
      <OrgSecuritySection />
    ) : section === 'webhooks' ? (
      <WebhooksSection />
    ) : section === 'authentication' ? (
      <AuthenticationSection />
    ) : section === 'audit' ? (
      <AuditSection />
    ) : section === 'labels' ? (
      <LabelsSection />
    ) : section === 'teams' ? (
      <TeamsSection />
    ) : (
      <AccountSection />
    );
  return (
    <SettingsShell active={meta.key} title={meta.label}>
      {body}
    </SettingsShell>
  );
}

export function TeamSettingsPage() {
  const { key } = useParams({ from: '/$slug/settings/team/$key' });
  const ws = useWorkspace();
  const team = ws.teamByKey.get(key);
  return (
    <SettingsShell active={`team:${key}`} title={team ? team.name : 'Team'}>
      {team ? <TeamSettings team={team} /> : <p className="text-muted">Team not found.</p>}
    </SettingsShell>
  );
}

export function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="section-label mb-2">{title}</div>
      {description && <p className="mb-4 text-[13px] text-muted">{description}</p>}
      {children}
    </section>
  );
}

export function FormRow({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-[12px] text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-index">{hint}</span>}
    </label>
  );
}
