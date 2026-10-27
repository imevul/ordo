import type { PendingOp } from '@ordo/sync';
import { Copy, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { t } from '../i18n/index.ts';
import { relativeTime } from '../lib/format.ts';
import { useSyncEngine, useSyncState } from '../sync/context.tsx';
import { Modal } from './ui/Modal.tsx';

/**
 * The local copy's outbox in the sidebar's status line: how many changes wait to be sent, and
 * the ones the server refused, which open a list to copy their text from and discard.
 */
export function SyncStatus() {
  const engine = useSyncEngine();
  const state = useSyncState();
  const [open, setOpen] = useState(false);
  if (!engine || !state) return null;
  const { waiting, failed } = state;
  return (
    <>
      {waiting > 0 && (
        <span className="normal-case tracking-normal">
          · {t('shell.sync.waiting', { count: waiting })}
        </span>
      )}
      {failed.length > 0 && (
        <button
          type="button"
          className="flex items-center gap-1 text-error hover:text-text"
          onClick={() => setOpen(true)}
        >
          <TriangleAlert size={11} /> {t('shell.sync.unsaved', { count: failed.length })}
        </button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} width={560} label={t('shell.sync.title')}>
        <div className="max-h-[70vh] overflow-y-auto p-6">
          <div className="section-label mb-2">{t('shell.sync.title')}</div>
          <p className="mb-4 text-[13px] text-muted">{t('shell.sync.description')}</p>
          {failed.map((p) => (
            <Unsaved key={p.key} entry={p} onDiscard={() => engine.dismiss(p.key)} />
          ))}
          {failed.length === 0 && (
            <p className="font-mono text-[12px] text-index">{t('shell.sync.none')}</p>
          )}
        </div>
      </Modal>
    </>
  );
}

function Unsaved({ entry, onDiscard }: { entry: PendingOp; onDiscard: () => void }) {
  const engine = useSyncEngine();
  const name = (id: string) => engine?.issue(id)?.identifier ?? id.slice(0, 8);
  const { op } = entry;
  let what: string;
  let text = '';
  switch (op.kind) {
    case 'issue.create':
      what = t('shell.sync.op.issueCreate', { title: op.issue.title });
      text = [op.issue.title, op.issue.description].filter(Boolean).join('\n\n');
      break;
    case 'issue.update':
      what = t('shell.sync.op.issueUpdate', { id: name(op.ids[0]!), count: op.ids.length });
      text = JSON.stringify(op.patch, null, 2);
      break;
    case 'issue.trash':
      what = t('shell.sync.op.issueTrash', { id: name(op.ids[0]!), count: op.ids.length });
      break;
    case 'comment.create':
      what = t('shell.sync.op.commentCreate', { id: name(op.comment.issueId) });
      text = op.comment.body;
      break;
    case 'comment.update':
      what = t('shell.sync.op.commentUpdate', { id: name(op.issueId) });
      text = op.body;
      break;
    case 'comment.delete':
      what = t('shell.sync.op.commentDelete', { id: name(op.issueId) });
      break;
    case 'reaction':
      what = t('shell.sync.op.reaction', { emoji: op.emoji, id: name(op.issueId) });
      break;
    case 'relation.create':
      what = t('shell.sync.op.relationCreate', { id: name(op.relation.issueId) });
      break;
    case 'relation.delete':
      what = t('shell.sync.op.relationDelete');
      break;
  }
  return (
    <div className="mb-3 border border-border-soft p-3">
      <div className="flex items-start gap-2 text-[13px]">
        <span className="min-w-0 flex-1">
          {what}
          <span className="block font-mono text-[11px] text-index">
            {relativeTime(entry.queuedAt)} · {entry.error}
          </span>
        </span>
        {text && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              navigator.clipboard?.writeText(text);
              toast.success(t('common.copied'));
            }}
          >
            <Copy size={12} /> {t('shell.sync.copy')}
          </button>
        )}
        <button type="button" className="btn btn-danger btn-sm" onClick={onDiscard}>
          <Trash2 size={12} /> {t('shell.sync.discard')}
        </button>
      </div>
      {text && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap bg-bg p-2 font-mono text-[11.5px] text-muted">
          {text}
        </pre>
      )}
    </div>
  );
}
