import type { Member } from '@ordo/shared';

/**
 * A member, a bot (which may belong to an integration that's since been removed), or a
 * placeholder for someone an import brought along.
 */
export type Person = Member & { bot?: boolean; removed?: boolean; placeholder?: boolean };

/**
 * Someone's name where they did something. A removed integration's bot keeps its name, followed
 * by a small "removed" tag rather than a sentence, so history lines stay one line; placeholders
 * get an "imported" tag the same way.
 */
export function ActorName({
  person,
  fallback = 'Someone',
  className = 'text-text',
}: {
  person: Person | null | undefined;
  fallback?: string;
  className?: string;
}) {
  if (!person) return <span className={className}>{fallback}</span>;
  return (
    <span className={className}>
      {person.name}
      {person.removed && (
        <span
          className="ml-1 cursor-help align-[1px] font-mono text-[9.5px] tracking-[0.1em] text-index uppercase"
          title="This integration was disconnected. What it did stays in the history."
        >
          removed
        </span>
      )}
      {person.placeholder && (
        <span
          className="ml-1 cursor-help align-[1px] font-mono text-[9.5px] tracking-[0.1em] text-index uppercase"
          title="Imported from another tool. Not an Ordo account yet: admins can merge it into one."
        >
          imported
        </span>
      )}
    </span>
  );
}
