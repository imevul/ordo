import { Link, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { TeamIcon } from '../../components/icons.tsx';
import { PageHeader, Sep } from '../../components/PageHeader.tsx';
import { type Catalog, t } from '../../i18n/index.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { useOnline } from '../../sync/context.tsx';
import { ApiKeysSection, CliCard } from './account/api-keys.tsx';
import { NotificationsSection, PushCard } from './account/notifications.tsx';
import { AccountSection } from './account/profile.tsx';
import { SecuritySection } from './account/security.tsx';
import { AgentsSection, RepositoriesSection } from './agents/index.tsx';
import { AiSection } from './ai.tsx';
import { AuditSection } from './audit.tsx';
import { ChatAccountsCard } from './chat/index.tsx';
import { ExportsCard, PlaceholdersCard } from './exports.tsx';
import { ImportsSection } from './imports.tsx';
import { GitAccountsCard, IntegrationsSection } from './integrations/index.tsx';
import { LabelsSection } from './labels.tsx';
import { McpSection } from './mcp.tsx';
import { AuthenticationSection, ConnectedAccountsCard } from './sso/index.tsx';
import { TeamSettings, TeamsSection } from './teams/index.tsx';
import { TemplatesSection } from './templates.tsx';
import { WebhooksSection } from './webhooks.tsx';
import { MembersSection, OrgSecuritySection, WorkspaceSection } from './workspace/index.tsx';

/** The sections in nav order. `label` is read when used, so it is in the current language. */
const SECTIONS: {
  key: string;
  message: Exclude<keyof Catalog['settings']['nav'], 'groups'>;
  group: 'account' | 'workspace';
  admin?: boolean;
  readonly label: string;
}[] = (
  [
    { key: 'account', message: 'profile', group: 'account' },
    { key: 'security', message: 'security', group: 'account' },
    { key: 'connected', message: 'connected', group: 'account' },
    { key: 'notifications', message: 'notifications', group: 'account' },
    { key: 'api', message: 'apiKeys', group: 'account' },
    { key: 'mcp', message: 'aiAgents', group: 'account' },
    { key: 'workspace', message: 'general', group: 'workspace', admin: true },
    { key: 'members', message: 'members', group: 'workspace' },
    { key: 'teams', message: 'teams', group: 'workspace' },
    { key: 'labels', message: 'labels', group: 'workspace' },
    { key: 'templates', message: 'templates', group: 'workspace' },
    // Invitations, domains and joining: who gets in. (The key predates the name.)
    { key: 'org-security', message: 'access', group: 'workspace', admin: true },
    { key: 'authentication', message: 'authentication', group: 'workspace', admin: true },
    { key: 'integrations', message: 'integrations', group: 'workspace', admin: true },
    { key: 'ai', message: 'aiAssistance', group: 'workspace', admin: true },
    { key: 'agents', message: 'agents', group: 'workspace', admin: true },
    { key: 'repositories', message: 'repositories', group: 'workspace', admin: true },
    { key: 'webhooks', message: 'webhooks', group: 'workspace', admin: true },
    { key: 'import', message: 'importExport', group: 'workspace', admin: true },
    { key: 'audit', message: 'auditLog', group: 'workspace', admin: true },
  ] as const
).map((s) => ({
  ...s,
  get label() {
    return t(`settings.nav.${s.message}`);
  },
}));

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
            {t('settings.nav.kicker')}
            <Sep />
            {active.startsWith('team:') ? t('settings.nav.kickerTeam') : title.toLowerCase()}
          </>
        }
        title={title}
      />
      <div className="flex min-h-0 flex-1">
        <nav
          className="hidden w-52 flex-none overflow-y-auto border-r border-border-soft p-3 md:block"
          aria-label={t('common.settings')}
        >
          {groups.map((g) => (
            <div key={g} className="mb-4">
              <div className="mb-1 px-2 font-mono text-[10.5px] font-semibold tracking-[0.2em] text-index uppercase">
                {t(`settings.nav.groups.${g}`)}
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
            {t('settings.nav.yourTeams')}
          </div>
          {ws.teams.map((team) => (
            <Link
              key={team.id}
              to="/$slug/settings/team/$key"
              params={{ slug: ws.slug, key: team.key }}
              className={`nav-item ${active === `team:${team.key}` ? 'active' : ''}`}
            >
              <TeamIcon color={team.color} label={team.key} size={14} /> {team.name}
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
  const online = useOnline();
  const ws = useWorkspace();
  const { section } = useParams({ from: '/$slug/settings/$section' });
  const meta = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0]!;
  const body =
    section === 'api' ? (
      <>
        <ApiKeysSection />
        <CliCard />
      </>
    ) : section === 'mcp' ? (
      <McpSection />
    ) : section === 'security' ? (
      <SecuritySection />
    ) : section === 'notifications' ? (
      <>
        <PushCard />
        <NotificationsSection />
      </>
    ) : section === 'workspace' ? (
      <WorkspaceSection />
    ) : section === 'members' ? (
      <MembersSection />
    ) : section === 'connected' ? (
      <>
        <ConnectedAccountsCard />
        <GitAccountsCard />
        <ChatAccountsCard />
      </>
    ) : section === 'org-security' ? (
      <OrgSecuritySection />
    ) : section === 'integrations' ? (
      <IntegrationsSection />
    ) : section === 'webhooks' ? (
      <WebhooksSection />
    ) : section === 'import' ? (
      ws.isAdmin ? (
        <>
          <ImportsSection />
          <PlaceholdersCard />
          <ExportsCard />
        </>
      ) : (
        <p className="text-muted">{t('settings.nav.adminsOnlyImport')}</p>
      )
    ) : section === 'authentication' ? (
      <AuthenticationSection />
    ) : section === 'ai' ? (
      <AiSection />
    ) : section === 'agents' ? (
      <AgentsSection />
    ) : section === 'repositories' ? (
      <RepositoriesSection />
    ) : section === 'audit' ? (
      <AuditSection />
    ) : section === 'labels' ? (
      <LabelsSection />
    ) : section === 'templates' ? (
      <TemplatesSection />
    ) : section === 'teams' ? (
      <TeamsSection />
    ) : (
      <AccountSection />
    );
  return (
    <SettingsShell active={meta.key} title={meta.label}>
      {!online && (
        <p className="mb-6 border border-border-soft px-3 py-2 text-[13px] text-muted">
          {t('shell.offline.settings')}
        </p>
      )}
      {body}
    </SettingsShell>
  );
}

export function TeamSettingsPage() {
  const { key } = useParams({ from: '/$slug/settings/team/$key' });
  const ws = useWorkspace();
  const team = ws.teamByKey.get(key);
  return (
    <SettingsShell active={`team:${key}`} title={team ? team.name : t('common.team')}>
      {team ? (
        <TeamSettings team={team} />
      ) : (
        <p className="text-muted">{t('settings.nav.teamNotFound')}</p>
      )}
    </SettingsShell>
  );
}
