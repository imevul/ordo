import type {
  Bootstrap,
  Cycle,
  Label,
  Me,
  Member,
  Project,
  Team,
  View,
  WorkflowState,
} from '@ordo/shared';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

export interface WorkspaceData extends Bootstrap {
  slug: string;
  me: Me;
  teamById: Map<string, Team>;
  teamByKey: Map<string, Team>;
  stateById: Map<string, WorkflowState>;
  memberById: Map<string, Member>;
  labelById: Map<string, Label>;
  projectById: Map<string, Project>;
  cycleById: Map<string, Cycle>;
  viewById: Map<string, View>;
  myTeams: Team[];
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
  const value = useMemo<WorkspaceData>(() => {
    const states = data.teams.flatMap((t) => t.states);
    const mine = data.teams.filter((t) => t.memberIds.includes(me.id));
    return {
      ...data,
      slug,
      me,
      teamById: byId(data.teams),
      teamByKey: new Map(data.teams.map((t) => [t.key, t])),
      stateById: byId(states),
      memberById: byId(data.members),
      labelById: byId(data.labels),
      projectById: byId(data.projects),
      cycleById: byId(data.cycles),
      viewById: byId(data.views),
      myTeams: mine.length ? mine : data.teams,
    };
  }, [data, me, slug]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkspace outside WorkspaceProvider');
  return v;
}

/** The cycle whose date range contains today, if any. */
export function currentCycle(
  cycles: Cycle[],
  teamId: string,
  today = new Date().toISOString().slice(0, 10),
) {
  return cycles.find((c) => c.teamId === teamId && c.startsAt <= today && c.endsAt > today) ?? null;
}

export function upcomingCycles(
  cycles: Cycle[],
  teamId: string,
  today = new Date().toISOString().slice(0, 10),
) {
  return cycles.filter((c) => c.teamId === teamId && c.endsAt > today);
}

export const cycleName = (c: Cycle) => c.name || `Cycle ${c.number}`;
