import type { IssueDetail, IssueLink, PullRequestChecks, PullRequestReview } from '@ordo/shared';
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  GitPullRequest,
  MessageSquareWarning,
} from 'lucide-react';
import { type MessageKey, t } from '../i18n/index.ts';
import { STATE_COLORS, STATE_KEYS } from './IssueLinks.tsx';

const CHECKS: Record<
  PullRequestChecks,
  { icon: typeof CircleCheck; color: string; key: MessageKey }
> = {
  passing: {
    icon: CircleCheck,
    color: 'var(--color-success)',
    key: 'issue.pullRequests.checks.passing',
  },
  failing: { icon: CircleX, color: 'var(--color-error)', key: 'issue.pullRequests.checks.failing' },
  pending: {
    icon: CircleDashed,
    color: 'var(--color-warning)',
    key: 'issue.pullRequests.checks.pending',
  },
};

const REVIEWS: Record<
  PullRequestReview,
  { icon: typeof CircleCheck; color: string; key: MessageKey }
> = {
  approved: {
    icon: CircleCheck,
    color: 'var(--color-success)',
    key: 'issue.pullRequests.review.approved',
  },
  changes_requested: {
    icon: MessageSquareWarning,
    color: 'var(--color-warning)',
    key: 'issue.pullRequests.review.changes_requested',
  },
};

/** The issue's pull requests with their state, checks and review; nothing when it has none. */
export function IssuePullRequests({
  issue,
  className,
}: {
  issue: IssueDetail;
  className?: string;
}) {
  const prs = issue.links.filter((l) => l.kind === 'pull_request').reverse();
  if (!prs.length) return null;
  return (
    <section className={className}>
      <div className="section-label mb-2">{t('issue.pullRequests.title')}</div>
      {prs.map((pr) => (
        <PullRequestRow key={pr.id} link={pr} />
      ))}
    </section>
  );
}

function PullRequestRow({ link }: { link: IssueLink }) {
  const pr = link.pullRequest;
  const color = link.state ? (STATE_COLORS[link.state] ?? 'var(--color-muted)') : undefined;
  const checks = pr?.checks ? CHECKS[pr.checks] : null;
  const review = pr?.review ? REVIEWS[pr.review] : null;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="row block border-b border-border-soft/60 px-2 py-2 hover:bg-text/[0.03]"
      title={link.title}
    >
      <div className="flex items-center gap-2">
        <GitPullRequest
          size={14}
          className="flex-none"
          style={{ color: color ?? 'var(--color-index)' }}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
          {pr ? `${pr.repo}#${pr.number}` : link.title}
        </span>
        {link.state && (
          <span className="chip flex-none" style={{ ['--chip' as string]: color }}>
            {STATE_KEYS[link.state] ? t(STATE_KEYS[link.state]!) : link.state}
          </span>
        )}
      </div>
      {(checks || review) && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-[22px] text-[12px] text-muted">
          {[checks, review].map(
            (s) =>
              s && (
                <span key={s.key} className="inline-flex items-center gap-1">
                  <s.icon size={12} style={{ color: s.color }} />
                  {t(s.key)}
                </span>
              ),
          )}
        </div>
      )}
      {pr?.branch && (
        <div className="mt-0.5 truncate pl-[22px] font-mono text-[11px] text-index">
          {pr.branch}
        </div>
      )}
    </a>
  );
}
