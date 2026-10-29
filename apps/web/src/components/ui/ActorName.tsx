import type { Member } from '@ordo/shared';
import { t } from '../../i18n/index.ts';

/**
 * A member (a person or an agent), a bot (which may belong to an integration that's since been
 * removed), or a placeholder for someone an import brought along.
 */
export type Person = Member & { bot?: boolean; removed?: boolean; placeholder?: boolean };

/**
 * Someone's name where they did something. A removed integration's bot keeps its name, followed
 * by a small "removed" tag rather than a sentence, so history lines stay one line; placeholders
 * get an "imported" tag the same way.
 */
export function ActorName({
  person,
  fallback = t('shell.actor.someone'),
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
          title={t('shell.actor.removedHint')}
        >
          {t('shell.actor.removed')}
        </span>
      )}
      {person.kind === 'agent' && (
        <span
          className="ml-1 cursor-help align-[1px] font-mono text-[9.5px] tracking-[0.1em] text-index uppercase"
          title={t('agents.agentHint')}
        >
          {t('agents.agentTag')}
        </span>
      )}
      {person.placeholder && (
        <span
          className="ml-1 cursor-help align-[1px] font-mono text-[9.5px] tracking-[0.1em] text-index uppercase"
          title={t('shell.actor.importedHint')}
        >
          {t('shell.actor.imported')}
        </span>
      )}
    </span>
  );
}
