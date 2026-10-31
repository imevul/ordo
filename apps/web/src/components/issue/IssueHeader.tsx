import { branchName, type IssueDetail, type Team } from '@ordo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  Copy,
  Link2,
  MoreHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../../api/client.ts';
import { useRestoreIssues, useTrashIssues, useWsMutation } from '../../api/queries.ts';
import { t } from '../../i18n/index.ts';
import { useHotkey } from '../../lib/hotkeys.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { type AiPanelKind, useAiEnabled } from '../AiAssist.tsx';
import { PageHeader, Sep } from '../PageHeader.tsx';
import { ConfirmModal } from '../ui/Modal.tsx';
import { Popover } from '../ui/Popover.tsx';

const copy = (text: string, message: string) => {
  navigator.clipboard?.writeText(text);
  toast.success(message);
};

/** The issue's page header: breadcrumb, AI, subscribe, copy link and the more-actions menu. */
export function IssueHeader({
  issue,
  team,
  compact,
  onAiPanel,
}: {
  issue: IssueDetail;
  team: Team | undefined;
  compact: boolean;
  onAiPanel: (kind: AiPanelKind) => void;
}) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const aiEnabled = useAiEnabled();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const subscribed = issue.subscriberIds.includes(ws.me.id);
  const p = { slug: ws.slug };

  const subscribe = useWsMutation(ws.slug, (on: boolean) =>
    on
      ? api.post(wsPath(ws.slug, `/issues/${issue.id}/subscription`))
      : api.del(wsPath(ws.slug, `/issues/${issue.id}/subscription`)),
  );
  const archive = useWsMutation(
    ws.slug,
    (on: boolean) =>
      api.post(wsPath(ws.slug, `/issues/${issue.id}/${on ? 'archive' : 'unarchive'}`)),
    {
      invalidate: [
        ['ws', ws.slug, 'issues'],
        ['ws', ws.slug, 'issue'],
      ],
    },
  );
  const trashIssues = useTrashIssues(ws.slug);
  const restore = useRestoreIssues(ws.slug);

  // Through the outbox with the local copy: offline it's queued, and Undo is queued after it.
  const trash = () =>
    trashIssues.mutate([issue.id], {
      onSuccess: () => {
        toast(t('issue.detail.trashed', { identifier: issue.identifier }), {
          action: { label: t('common.undo'), onClick: () => restore.mutate([issue.id]) },
        });
        if (compact) return;
        if (team)
          navigate({ to: '/$slug/team/$key/$tab', params: { ...p, key: team.key, tab: 'all' } });
        else navigate({ to: '/$slug', params: p });
      },
    });

  // Linking a PR is as easy as naming the branch after the issue.
  const copyBranch = () =>
    copy(
      branchName(ws.workspace.settings.gitBranchFormat, {
        identifier: issue.identifier,
        title: issue.title,
        username: ws.me.username,
      }),
      t('issue.detail.branchCopied'),
    );
  // By physical key: on Nordic layouts Shift+. types ":", so "mod+>" would be unreachable.
  useHotkey('mod+shift+[Period]', copyBranch, { enabled: !compact });

  return (
    <>
      <PageHeader
        kicker={
          <>
            {team ? (
              <Link
                to="/$slug/team/$key/$tab"
                params={{ ...p, key: team.key, tab: 'all' }}
                className="hover:text-highlight"
              >
                {team.name}
              </Link>
            ) : (
              <span title={t('issue.detail.teamUnavailableTitle')}>
                {t('issue.detail.teamUnavailable')}
              </span>
            )}
            <Sep />
            {issue.identifier}
            {issue.deletedAt && <span className="text-error"> {t('issue.detail.inTrash')}</span>}
            {issue.archivedAt && !issue.deletedAt && (
              <span className="text-index"> {t('issue.detail.archived')}</span>
            )}
          </>
        }
        title={compact ? issue.title : <span className="text-muted">{issue.identifier}</span>}
        actions={
          <>
            {aiEnabled && (
              <Popover
                placement="bottom-end"
                width={200}
                trigger={
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={t('issue.detail.askAi')}
                  >
                    <Sparkles size={13} />
                    <span className="hidden lg:inline">{t('issue.detail.askAi')}</span>
                  </button>
                }
              >
                {(close) => (
                  <div className="py-1" onClick={close}>
                    <button
                      type="button"
                      className="menu-item"
                      onClick={() => onAiPanel('summary')}
                    >
                      {t('issue.detail.summarize')}
                    </button>
                    <button type="button" className="menu-item" onClick={() => onAiPanel('triage')}>
                      {t('issue.detail.suggestProperties')}
                    </button>
                  </div>
                )}
              </Popover>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => subscribe.mutate(!subscribed)}
              title={subscribed ? t('issue.detail.unsubscribe') : t('issue.detail.subscribeTitle')}
              aria-pressed={subscribed}
            >
              {subscribed ? <BellOff size={13} /> : <Bell size={13} />}
              <span className="hidden lg:inline">
                {subscribed ? t('issue.detail.unsubscribe') : t('issue.detail.subscribe')}
              </span>
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                copy(
                  `${location.origin}/${ws.slug}/issue/${issue.identifier}`,
                  t('issue.detail.linkCopied'),
                )
              }
              aria-label={t('issue.detail.copyLink')}
            >
              <Link2 size={13} />
            </button>
            <Popover
              placement="bottom-end"
              width={200}
              trigger={
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('issue.detail.moreActions')}
                >
                  <MoreHorizontal size={14} />
                </button>
              }
            >
              {(close) => (
                <div className="py-1" onClick={close}>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => copy(issue.identifier, t('issue.detail.idCopied'))}
                  >
                    <Copy size={14} /> {t('issue.detail.copyId')}
                  </button>
                  <button type="button" className="menu-item" onClick={copyBranch}>
                    <Copy size={14} /> {t('issue.detail.copyBranch')}
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => archive.mutate(!issue.archivedAt)}
                  >
                    {issue.archivedAt ? (
                      <>
                        <ArchiveRestore size={14} /> {t('common.unarchive')}
                      </>
                    ) : (
                      <>
                        <Archive size={14} /> {t('common.archive')}
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    className="menu-item text-error"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 size={14} /> {t('issue.detail.moveToTrash')}
                  </button>
                </div>
              )}
            </Popover>
          </>
        }
      />
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('issue.detail.confirmTrashTitle', { identifier: issue.identifier })}
        body={t('issue.detail.confirmTrashBody')}
        confirmLabel={t('issue.detail.moveToTrash')}
        danger
        onConfirm={trash}
      />
    </>
  );
}
