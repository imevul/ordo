/**
 * Whether a cycle is running on `today`. `endsAt` is exclusive: on that day the next cycle has
 * started. Dates are compared as `YYYY-MM-DD`, so full ISO timestamps work too. Pass the
 * workspace's today (`dayInZone(workspace.settings.timezone)`), the day cycle automation uses.
 */
export function isCycleCurrent(cycle: { startsAt: string; endsAt: string }, today: string) {
  const day = today.slice(0, 10);
  return cycle.startsAt.slice(0, 10) <= day && cycle.endsAt.slice(0, 10) > day;
}
