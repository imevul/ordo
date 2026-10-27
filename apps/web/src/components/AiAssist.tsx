import type { AiSummary, AiTriage, IssueDetail, UpdateIssueInput } from '@ordo/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RefreshCw, Sparkles, X } from 'lucide-react';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { priorityLabel } from '../i18n/labels.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { PriorityIcon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';

export type AiPanelKind = 'summary' | 'triage';

/** Whether AI assistance is available here: set up on the instance and on in this workspace. */
export function useAiEnabled() {
  const ws = useWorkspace();
  return !!ws.ai?.enabled;
}

/** Who answers, for the small print under every AI result. */
function useModelName() {
  const ws = useWorkspace();
  if (!ws.ai) return '';
  return ws.ai.provider === 'anthropic' ? `Claude (${ws.ai.model})` : ws.ai.model;
}

/**
 * A summary or triage suggestions for an issue, asked for when the panel opens and kept until
 * someone asks again (applying a suggestion shouldn't cost another request). Nothing is applied
 * until someone clicks.
 */
export function IssueAiPanel({
  kind,
  issue,
  onPatch,
  onClose,
}: {
  kind: AiPanelKind;
  issue: IssueDetail;
  onPatch: (p: UpdateIssueInput) => void;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const model = useModelName();
  const query = useQuery({
    queryKey: ['ws', ws.slug, 'ai', kind, issue.id],
    queryFn: () =>
      api.post<AiSummary | AiTriage>(wsPath(ws.slug, `/ai/issues/${issue.id}/${kind}`)),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  return (
    <section className="panel mt-6 p-4" aria-live="polite">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={13} className="text-primary" />
        <span className="section-label flex-1">
          {kind === 'summary' ? t('issue.ai.summary') : t('issue.ai.suggestions')}
        </span>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center text-index hover:text-text disabled:opacity-40"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
          aria-label={t('issue.ai.askAgain')}
          title={t('issue.ai.askAgain')}
        >
          <RefreshCw size={12} />
        </button>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <X size={13} />
        </button>
      </div>
      {query.isFetching ? (
        <p className="font-mono text-[12px] text-index">
          &gt; {t('issue.ai.thinking')}
          <span className="cursor-blink" aria-hidden />
        </p>
      ) : query.error ? (
        <p className="text-[13px] text-error">{query.error.message}</p>
      ) : query.data && kind === 'summary' ? (
        <Markdown source={(query.data as AiSummary).summary} className="text-[13.5px]" />
      ) : query.data ? (
        <TriageSuggestions issue={issue} triage={query.data as AiTriage} onPatch={onPatch} />
      ) : null}
      <p className="mt-3 font-mono text-[10.5px] text-index">
        {t('issue.ai.disclaimer', { model })}
      </p>
    </section>
  );
}

function TriageSuggestions({
  issue,
  triage,
  onPatch,
}: {
  issue: IssueDetail;
  triage: AiTriage;
  onPatch: (p: UpdateIssueInput) => void;
}) {
  const ws = useWorkspace();
  const markDuplicate = useWsMutation(
    ws.slug,
    (relatedIssueId: string) =>
      api.post(wsPath(ws.slug, `/issues/${issue.id}/relations`), {
        type: 'duplicate_of',
        relatedIssueId,
      }),
    { success: t('issue.ai.markedDuplicate'), invalidate: [['ws', ws.slug, 'issue']] },
  );
  const labels = triage.labelIds
    .filter((id) => !issue.labelIds.includes(id))
    .map((id) => ws.labelById.get(id))
    .filter((l) => !!l);
  const priority =
    triage.priority !== null && triage.priority !== issue.priority ? triage.priority : null;
  const linked = new Set(issue.relations.map((r) => r.issue.id));
  const nothing = priority === null && !labels.length && !triage.duplicates.length;

  return (
    <div className="space-y-3 text-[13px]">
      {triage.reason && <p className="text-muted">{triage.reason}</p>}
      {nothing && <p className="text-index">{t('issue.ai.nothingToChange')}</p>}
      {priority !== null && (
        <div className="flex items-center gap-2">
          <span className="w-20 text-[12px] text-index">{t('common.priority')}</span>
          <span className="flex items-center gap-1.5">
            <PriorityIcon priority={priority} size={13} /> {priorityLabel(priority)}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm ml-auto"
            onClick={() => onPatch({ priority })}
          >
            {t('issue.ai.set')}
          </button>
        </div>
      )}
      {labels.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="w-20 flex-none text-[12px] text-index">{t('common.labels')}</span>
          <span className="flex flex-wrap gap-1">
            {labels.map((l) => (
              <span key={l.id} className="tag">
                <span className="tag-dot" style={{ background: l.color }} />
                {l.name}
              </span>
            ))}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm ml-auto"
            onClick={() => onPatch({ addLabelIds: labels.map((l) => l.id) })}
          >
            {t('common.add')}
          </button>
        </div>
      )}
      {triage.duplicates.length > 0 && (
        <div>
          <div className="mb-1 text-[12px] text-index">{t('issue.ai.possibleDuplicates')}</div>
          {triage.duplicates.map((d) => (
            <div key={d.id} className="flex items-start gap-2 border-t border-border-soft py-2">
              <div className="min-w-0 flex-1">
                <Link
                  to="/$slug/issue/$identifier"
                  params={{ slug: ws.slug, identifier: d.identifier }}
                  className="hover:text-highlight"
                >
                  <span className="font-mono text-[11.5px] text-index">{d.identifier}</span>{' '}
                  {d.title}
                </Link>
                <p className="text-[12px] text-muted">{d.reason}</p>
              </div>
              {!linked.has(d.id) && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm flex-none"
                  onClick={() => markDuplicate.mutate(d.id)}
                  disabled={markDuplicate.isPending}
                >
                  {t('issue.ai.markDuplicate')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
