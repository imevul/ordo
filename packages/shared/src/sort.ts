/**
 * Fractional ordering helpers. Items carry a float `sortOrder`; inserting between two
 * neighbours takes the midpoint, so reordering touches a single row.
 */
export const SORT_GAP = 1024;

export function sortOrderBetween(before?: number | null, after?: number | null): number {
  if (before == null && after == null) return 0;
  if (before == null) return (after as number) - SORT_GAP;
  if (after == null) return before + SORT_GAP;
  return (before + after) / 2;
}
