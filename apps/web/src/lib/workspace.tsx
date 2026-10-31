import type {
  Bootstrap,
  CustomField,
  Cycle,
  Dashboard,
  Label,
  Me,
  Project,
  Release,
  Team,
  View,
  WorkflowState,
} from '@ordo/shared';
import {
  accentVariables,
  defaultAssigneeFor,
  isAdminRole,
  isCycleCurrent,
  isGuestRole,
  isOwnerRole,
  isTeamAdminRole,
} from '@ordo/shared';
import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react';
import type { Person } from '../components/ui/ActorName.tsx';
import { t } from '../i18n/index.ts';
import { useTheme } from './theme.ts';

export interface WorkspaceData extends Bootstrap {
  slug: string;
  me: Me;
  teamById: Map<string, Team>;
  teamByKey: Map<string, Team>;
  stateById: Map<string, WorkflowState>;
  /**
   * Members, and the workspace's bots, placeholders and former members (flagged), for showing who
   * did what.
   */
  memberById: Map<string, Person>;
  labelById: Map<string, Label>;
  customFieldById: Map<string, CustomField>;
  projectById: Map<string, Project>;
  cycleById: Map<string, Cycle>;
  releaseById: Map<string, Release>;
  viewById: Map<string, View>;
  dashboardById: Map<string, Dashboard>;
  /** Teams the user has joined (or every visible team, if none). Drives the sidebar. */
  myTeams: Team[];
  isOwner: boolean;
  isAdmin: boolean;
  isGuest: boolean;
  /** Workspace admins, and team admins of this team. */
  canAdminTeam: (teamId: string) => boolean;
}

const Ctx = createContext<WorkspaceData | null>(null);

const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));

export function WorkspaceProvider({
  data,
  me,
  slug,
  children,
}: {
  data: Bootstrap;
  me: Me;
  slug: string;
  children: ReactNode;
}) {
  useAccent(data.workspace.settings.accentColor);
  const value = useMemo<WorkspaceData>(() => {
    const states = data.teams.flatMap((t) => t.states);
    const mine = data.teams.filter((t) => t.memberIds.includes(me.id));
    // A local copy saved before custom fields existed has none.
    const customFields = data.customFields ?? [];
    return {
      ...data,
      customFields,
      customFieldById: byId(customFields),
      slug,
      me,
      teamById: byId(data.teams),
      teamByKey: new Map(data.teams.map((t) => [t.key, t])),
      stateById: byId(states),
      // Bots, placeholders and former members aren't members (no pickers, no seats) but render
      // where they appear.
      memberById: byId([
        ...(data.bots ?? []).map(
          (b): Person => ({
            ...b,
            kind: 'human',
            role: 'member',
            joinedAt: '',
            suspended: false,
            status: null,
            bot: true,
          }),
        ),
        ...(data.placeholders ?? []).map(
          (p): Person => ({
            ...p,
            kind: 'human',
            role: 'member',
            joinedAt: '',
            suspended: false,
            status: null,
            placeholder: true,
          }),
        ),
        ...(data.formerMembers ?? []).map(
          (p): Person => ({
            ...p,
            role: 'member',
            joinedAt: '',
            suspended: false,
            status: null,
            former: true,
          }),
        ),
        ...data.members,
      ]),
      labelById: byId(data.labels),
      projectById: byId(data.projects),
      cycleById: byId(data.cycles),
      releaseById: byId(data.releases),
      viewById: byId(data.views),
      dashboardById: byId(data.dashboards),
      myTeams: mine.length ? mine : data.teams,
      isOwner: isOwnerRole(data.role),
      isAdmin: isAdminRole(data.role),
      isGuest: isGuestRole(data.role),
      canAdminTeam: (teamId: string) =>
        isAdminRole(data.role) ||
        !!data.teams
          .find((t) => t.id === teamId)
          ?.members.some((m) => m.userId === me.id && isTeamAdminRole(m.role)),
    };
  }, [data, me, slug]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkspace outside WorkspaceProvider');
  return v;
}

/** The cycle whose date range contains `today` (`dayInZone` of the workspace's time zone), if any. */
export function currentCycle(cycles: Cycle[], teamId: string, today: string) {
  return cycles.find((c) => c.teamId === teamId && isCycleCurrent(c, today)) ?? null;
}

export function upcomingCycles(
  cycles: Cycle[],
  teamId: string,
  today = new Date().toISOString().slice(0, 10),
) {
  return cycles.filter((c) => c.teamId === teamId && c.endsAt > today);
}

/** Members for a plain select: people by name, then agents (labelled as such). */
export function memberChoices(ws: WorkspaceData) {
  return [...ws.members]
    .filter((m) => !m.suspended)
    .sort(
      (a, b) =>
        Number(a.kind === 'agent') - Number(b.kind === 'agent') || a.name.localeCompare(b.name),
    )
    .map((m) => ({
      id: m.id,
      label: m.kind === 'agent' ? `${m.name} (${t('agents.agentTag')})` : m.name,
    }));
}

/**
 * Who a new issue in this team and project goes to by default, if they can work in the team
 * (agents and private teams need membership). Mirrors the server's choice for issues created
 * without an assignee.
 */
export function defaultAssigneeOf(ws: WorkspaceData, teamId: string, projectId: string | null) {
  const id = defaultAssigneeFor(
    ws.workspace.settings.defaultAssigneeId,
    projectId ? ws.projectById.get(projectId) : null,
  );
  const member = id ? ws.members.find((m) => m.id === id && !m.suspended) : null;
  const team = ws.teamById.get(teamId);
  if (!member || !team) return null;
  const needsMembership = member.kind === 'agent' || isGuestRole(member.role) || team.private;
  const isAdmin = isAdminRole(member.role);
  return !needsMembership || isAdmin || team.memberIds.includes(member.id) ? member.id : null;
}

export const cycleName = (c: Cycle) => c.name || t('common.cycleNumber', { number: c.number });

/**
 * Puts the workspace's accent on the document while it's open; leaving restores Hotline Pink
 * (sign-in pages don't know the workspace).
 */
export function useAccent(color: string | null | undefined) {
  const { mode } = useTheme();
  useEffect(() => {
    const root = document.documentElement.style;
    const vars = accentVariables(color, mode);
    for (const [name, value] of Object.entries(vars)) root.setProperty(name, value);
    return () => {
      for (const name of Object.keys(vars)) root.removeProperty(name);
    };
  }, [color, mode]);
}
