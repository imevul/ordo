/** What drafting release notes needs to know about an issue. */
export interface ReleaseNoteIssue {
  identifier: string;
  title: string;
  labelIds: string[];
}

/**
 * Release notes drafted from issue titles, one section per label. An issue with several labels
 * goes under the one most issues share, so sections stay few; issues without a label come last
 * under `otherHeading`. Sections run from largest to smallest, then by name.
 */
export function draftReleaseNotes(
  items: ReleaseNoteIssue[],
  labels: { id: string; name: string }[],
  otherHeading: string,
): string {
  const names = new Map(labels.map((l) => [l.id, l.name]));
  const uses = new Map<string, number>();
  for (const i of items)
    for (const l of i.labelIds) if (names.has(l)) uses.set(l, (uses.get(l) ?? 0) + 1);
  const sections = new Map<string | null, ReleaseNoteIssue[]>();
  for (const i of items) {
    const known = i.labelIds.filter((l) => names.has(l));
    const best = known.sort(
      (a, b) => uses.get(b)! - uses.get(a)! || names.get(a)!.localeCompare(names.get(b)!),
    )[0];
    const key = best ?? null;
    sections.set(key, [...(sections.get(key) ?? []), i]);
  }
  const ordered = [...sections.entries()].sort(([a, ai], [b, bi]) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return bi.length - ai.length || names.get(a)!.localeCompare(names.get(b)!);
  });
  return ordered
    .map(([key, list]) => {
      const heading = key === null ? otherHeading : names.get(key)!;
      const lines = list.map((i) => `- ${i.title.trim()} (${i.identifier})`);
      return `## ${heading}\n\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

/** A release as one Markdown document: its name and date as a heading, then the notes. */
export function releaseMarkdown(r: {
  name: string;
  notes: string;
  releasedAt: string | null;
  targetDate: string | null;
}): string {
  const date = r.releasedAt?.slice(0, 10) ?? r.targetDate;
  const heading = date ? `# ${r.name} (${date})` : `# ${r.name}`;
  const body = r.notes.trim();
  return body ? `${heading}\n\n${body}\n` : `${heading}\n`;
}
