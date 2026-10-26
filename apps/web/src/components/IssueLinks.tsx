import type { IssueDetail, IssueLink, IssueLinkKind } from '@ordo/shared';
import {
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Link2,
  MessageSquare,
  Plus,
  X,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { relativeTime } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Popover } from './ui/Popover.tsx';

const KIND_ICONS: Record<IssueLinkKind, typeof Link2> = {
  pull_request: GitPullRequest,
  branch: GitBranch,
  commit: GitCommitHorizontal,
  message: MessageSquare,
  link: Link2,
};

/** Chip colours for the states forges report. */
const STATE_COLORS: Record<string, string> = {
  open: 'var(--color-primary)',
  draft: 'var(--color-index)',
  review: 'var(--color-warning)',
  merged: 'var(--color-success)',
  closed: 'var(--color-muted)',
};

/** Pull requests, branches, commits, messages and plain links attached to an issue. */
export function IssueLinks({ issue, onChange }: { issue: IssueDetail; onChange: () => void }) {
  const ws = useWorkspace();
  const add = useWsMutation(ws.slug, (v: { url: string; title?: string }) =>
    api.post(wsPath(ws.slug, `/issues/${issue.id}/links`), v),
  );
  const remove = useWsMutation(ws.slug, (id: string) =>
    api.del(wsPath(ws.slug, `/issue-links/${id}`)),
  );
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');

  const submit = (close: () => void) => (e: FormEvent) => {
    e.preventDefault();
    add.mutate(
      { url: url.trim(), title: title.trim() || undefined },
      {
        onSuccess: () => {
          setUrl('');
          setTitle('');
          close();
          onChange();
        },
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : 'Could not add the link'),
      },
    );
  };

  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center gap-3">
        <div className="section-label flex-1">Links</div>
        <Popover
          width={340}
          trigger={
            <button type="button" className="btn btn-ghost btn-sm">
              <Plus size={12} /> Add link
            </button>
          }
        >
          {(close) => (
            <form className="p-3" onSubmit={submit(close)}>
              <input
                className="input mb-2 font-mono"
                type="url"
                placeholder="https://"
                required
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-label="URL"
              />
              <input
                className="input mb-3"
                placeholder="Title (optional)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Title"
              />
              <button className="btn btn-primary btn-sm w-full" disabled={add.isPending}>
                Add
              </button>
            </form>
          )}
        </Popover>
      </div>
      {issue.links.map((link) => (
        <LinkRow
          key={link.id}
          link={link}
          onRemove={() => remove.mutate(link.id, { onSuccess: onChange })}
        />
      ))}
      {issue.links.length === 0 && (
        <p className="px-2 font-mono text-[12px] text-index">
          // pull requests and links show up here
        </p>
      )}
    </section>
  );
}

function LinkRow({ link, onRemove }: { link: IssueLink; onRemove: () => void }) {
  const Icon = KIND_ICONS[link.kind] ?? Link2;
  const color = link.state ? (STATE_COLORS[link.state] ?? 'var(--color-muted)') : undefined;
  return (
    <div className="row group flex h-9 items-center gap-2.5 border-b border-border-soft/60 px-2">
      <Icon size={14} className="flex-none" style={{ color: color ?? 'var(--color-index)' }} />
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 flex-1 truncate text-[13.5px] hover:text-highlight"
        title={link.url}
      >
        {link.title}
      </a>
      {link.state && (
        <span className="chip flex-none" style={{ ['--chip' as string]: color }}>
          {link.state}
        </span>
      )}
      <span className="hidden flex-none font-mono text-[11px] text-index sm:inline">
        {[link.provider === 'web' ? null : link.provider, link.author, relativeTime(link.updatedAt)]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <button
        type="button"
        className="flex h-6 w-6 flex-none items-center justify-center text-index opacity-0 group-hover:opacity-100 hover:text-text"
        onClick={onRemove}
        aria-label="Remove link"
      >
        <X size={13} />
      </button>
    </div>
  );
}
