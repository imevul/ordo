import type { IssueDetail, RelationView } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { api, wsPath } from '../../api/client.ts';
import { invalidateIssues, useWsMutation } from '../../api/queries.ts';
import { type MessageKey, t } from '../../i18n/index.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { useSyncEngine } from '../../sync/context.tsx';
import { IssueSearchPicker } from '../IssueSearchPicker.tsx';
import { StatusIcon } from '../icons.tsx';

const RELATION_KEYS = {
  blocks: 'issue.relations.blocks',
  blocked_by: 'issue.relations.blockedBy',
  related: 'issue.relations.related',
  duplicate_of: 'issue.relations.duplicateOf',
  duplicated_by: 'issue.relations.duplicatedBy',
} as const satisfies Record<RelationView, MessageKey>;

export function IssueRelations({ issue }: { issue: IssueDetail }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const engine = useSyncEngine();
  const done = () => invalidateIssues(qc, ws.slug);
  const addRelation = useWsMutation(ws.slug, (v: { type: string; relatedIssueId: string }) =>
    engine
      ? engine.mutate({
          kind: 'relation.create',
          relation: { id: crypto.randomUUID(), issueId: issue.id, ...v },
        })
      : api.post(wsPath(ws.slug, `/issues/${issue.id}/relations`), v),
  );
  const removeRelation = useWsMutation(ws.slug, (id: string) =>
    engine
      ? engine.mutate({ kind: 'relation.delete', id })
      : api.del(wsPath(ws.slug, `/relations/${id}`)),
  );
  const [relType, setRelType] = useState<'blocks' | 'blocked_by' | 'related' | 'duplicate_of'>(
    'related',
  );

  return (
    <section className="mt-8">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="section-label flex-1">{t('issue.relations.title')}</div>
        <select
          value={relType}
          onChange={(e) => setRelType(e.target.value as typeof relType)}
          className="h-[1.625rem] border border-border bg-bg px-1.5 text-[12px] text-muted outline-none focus:border-primary"
          aria-label={t('issue.relations.type')}
        >
          {(['related', 'blocks', 'blocked_by', 'duplicate_of'] as const).map((type) => (
            <option key={type} value={type}>
              {t(RELATION_KEYS[type])}
            </option>
          ))}
        </select>
        <IssueSearchPicker
          exclude={[issue.id, ...issue.relations.map((r) => r.issue.id)]}
          onPick={(other) =>
            addRelation.mutate({ type: relType, relatedIssueId: other.id }, { onSuccess: done })
          }
          trigger={
            <button type="button" className="btn btn-ghost btn-sm">
              <Plus size={12} /> {t('issue.relations.link')}
            </button>
          }
        />
      </div>
      {issue.relations.map((r) => {
        const st = ws.stateById.get(r.issue.stateId);
        return (
          <div
            key={r.id}
            className="row group flex h-9 items-center gap-2.5 border-b border-border-soft/60 px-2"
          >
            <span
              className={`w-24 flex-none font-mono text-[10.5px] tracking-[0.08em] uppercase ${r.type === 'blocked_by' ? 'text-warning' : 'text-index'}`}
            >
              {t(RELATION_KEYS[r.type])}
            </span>
            {st && <StatusIcon type={st.type} color={st.color} />}
            <span className="w-16 flex-none font-mono text-[11px] text-index">
              {r.issue.identifier}
            </span>
            <Link
              to="/$slug/issue/$identifier"
              params={{ slug: ws.slug, identifier: r.issue.identifier }}
              className="min-w-0 flex-1 truncate text-[13.5px]"
            >
              {r.issue.title}
            </Link>
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center text-index opacity-0 group-hover:opacity-100 hover:text-text"
              onClick={() => removeRelation.mutate(r.id, { onSuccess: done })}
              aria-label={t('issue.relations.remove')}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </section>
  );
}
