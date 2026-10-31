import type { IssueDetail, UpdateIssueInput } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { invalidateIssues, useUpdateIssue } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { useHotkey } from '../lib/hotkeys.ts';
import { ui } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Activity } from './Activity.tsx';
import { AgentRuns } from './AgentRuns.tsx';
import { type AiPanelKind, IssueAiPanel } from './AiAssist.tsx';
import { CustomerRequests } from './CustomerRequests.tsx';
import { IssueAttachments } from './IssueAttachments.tsx';
import { IssueLinks } from './IssueLinks.tsx';
import { IssuePullRequests } from './IssuePullRequests.tsx';
import { IssueHeader } from './issue/IssueHeader.tsx';
import { IssueRelations } from './issue/IssueRelations.tsx';
import { IssueProperties, IssueSidebar } from './issue/IssueSidebar.tsx';
import { IssueDescription, IssueTitle } from './issue/IssueText.tsx';
import { SubIssues } from './issue/SubIssues.tsx';

export function IssueDetailView({
  issue,
  compact = false,
  focusCommentId,
}: {
  issue: IssueDetail;
  compact?: boolean;
  focusCommentId?: string | null;
}) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const update = useUpdateIssue(ws.slug);
  const [aiPanel, setAiPanel] = useState<AiPanelKind | null>(null);
  // A panel belongs to the issue it was opened on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the issue changes
  useEffect(() => setAiPanel(null), [issue.id]);
  const patch = (p: UpdateIssueInput) => update.mutate({ id: issue.id, patch: p });
  // Missing if access to the team was just revoked (the issue refetch will 404 next) or the issue
  // arrived before the refreshed workspace data; show what we can until it settles.
  const team = ws.teamById.get(issue.teamId);
  const done = () => invalidateIssues(qc, ws.slug);

  useEffect(() => {
    if (compact) return;
    ui.set({ contextIssues: [issue.id] });
    return () => ui.set({ contextIssues: [] });
  }, [issue.id, compact]);

  useHotkey('s', () => ui.openPalette('status', [issue.id]), { enabled: !compact });
  useHotkey('p', () => ui.openPalette('priority', [issue.id]), { enabled: !compact });
  useHotkey('a', () => ui.openPalette('assignee', [issue.id]), { enabled: !compact });
  useHotkey('l', () => ui.openPalette('labels', [issue.id]), { enabled: !compact });
  useHotkey('shift+p', () => ui.openPalette('project', [issue.id]), { enabled: !compact });
  useHotkey('shift+c', () => ui.openPalette('cycle', [issue.id]), { enabled: !compact });
  useHotkey('e', () => ui.openPalette('estimate', [issue.id]), { enabled: !compact });
  useHotkey('i', () => patch({ assigneeId: issue.assigneeId === ws.me.id ? null : ws.me.id }), {
    enabled: !compact,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <IssueHeader issue={issue} team={team} compact={compact} onAiPanel={setAiPanel} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-6 py-8">
            {issue.parent && (
              <Link
                to="/$slug/issue/$identifier"
                params={{ slug: ws.slug, identifier: issue.parent.identifier }}
                className="mb-3 inline-flex items-center gap-2 font-mono text-[11.5px] text-index hover:text-highlight"
              >
                <span className="text-muted">↑</span> {issue.parent.identifier}{' '}
                <span className="font-sans text-muted">{issue.parent.title}</span>
              </Link>
            )}
            <IssueTitle issue={issue} onSave={(title) => patch({ title })} />
            {/* The sidebar has them on wide screens. */}
            <section className="mt-4 border-y border-border-soft py-3 lg:hidden">
              <div className="section-label mb-2">{t('issue.detail.properties')}</div>
              <div className="grid gap-x-6 sm:grid-cols-2">
                <IssueProperties issue={issue} team={team} onPatch={patch} />
              </div>
            </section>
            <IssueDescription issue={issue} onSave={(description) => patch({ description })} />
            {aiPanel && (
              <IssueAiPanel
                key={aiPanel}
                kind={aiPanel}
                issue={issue}
                onPatch={patch}
                onClose={() => setAiPanel(null)}
              />
            )}

            <SubIssues issue={issue} />
            <IssueRelations issue={issue} />
            <IssueAttachments issue={issue} onChange={done} />
            {/* The sidebar has them on wide screens. */}
            <IssuePullRequests issue={issue} className="mt-8 lg:hidden" />
            <IssueLinks issue={issue} onChange={done} />
            <AgentRuns issue={issue} />
            <CustomerRequests issue={issue} onChange={done} />

            <Activity issue={issue} focusCommentId={focusCommentId} />
          </div>
        </div>

        <IssueSidebar issue={issue} team={team} onPatch={patch} />
      </div>
    </div>
  );
}
