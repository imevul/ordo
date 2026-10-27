import type { Cycle, Label, Milestone, Progress, Project, ProjectHealth, View } from '@ordo/shared';
import { DEFAULT_ISSUE_DISPLAY } from '@ordo/shared';
import type { cycles, labels, projectMilestones, projects, views } from '../db/schema.ts';
import { emptyProgress } from './progress.ts';

export const toLabel = (l: typeof labels.$inferSelect): Label => ({
  id: l.id,
  teamId: l.teamId,
  name: l.name,
  color: l.color,
});

export const toCycle = (c: typeof cycles.$inferSelect, progress?: Progress): Cycle => ({
  id: c.id,
  teamId: c.teamId,
  number: c.number,
  name: c.name,
  description: c.description,
  startsAt: c.startsAt,
  endsAt: c.endsAt,
  progress: progress ?? emptyProgress(),
});

export const toProject = (
  p: typeof projects.$inferSelect,
  teamIds: string[],
  progress?: Progress,
  health?: ProjectHealth | null,
  milestones: Milestone[] = [],
): Project => ({
  id: p.id,
  name: p.name,
  description: p.description,
  color: p.color,
  status: p.status,
  leadId: p.leadId,
  startDate: p.startDate,
  targetDate: p.targetDate,
  teamIds,
  sortOrder: p.sortOrder,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  progress: progress ?? emptyProgress(),
  health: health ?? null,
  milestones,
  initiativeId: p.initiativeId,
});

export const toMilestone = (
  m: typeof projectMilestones.$inferSelect,
  progress?: Progress,
): Milestone => ({
  id: m.id,
  projectId: m.projectId,
  name: m.name,
  description: m.description,
  targetDate: m.targetDate,
  sortOrder: m.sortOrder,
  progress: progress ?? emptyProgress(),
});

export const toView = (v: typeof views.$inferSelect): View => ({
  id: v.id,
  name: v.name,
  description: v.description,
  ownerId: v.ownerId,
  teamId: v.teamId,
  shared: v.shared,
  filters: v.filters,
  display: { ...DEFAULT_ISSUE_DISPLAY, ...v.display },
  createdAt: v.createdAt,
  updatedAt: v.updatedAt,
});
