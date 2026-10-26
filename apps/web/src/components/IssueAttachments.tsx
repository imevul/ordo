import type { Attachment, IssueDetail } from '@ordo/shared';
import { Paperclip, Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../api/client.ts';
import { useAttachmentUpload, useWsMutation } from '../api/queries.ts';
import { fileSize, relativeTime } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';

/** Files on an issue: attached here, or pasted into its description and comments. */
export function IssueAttachments({
  issue,
  onChange,
}: {
  issue: IssueDetail;
  onChange: () => void;
}) {
  const ws = useWorkspace();
  const upload = useAttachmentUpload(ws.slug, issue.id);
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(0);
  const [dragging, setDragging] = useState(false);
  const remove = useWsMutation(ws.slug, (id: string) =>
    api.del(wsPath(ws.slug, `/attachments/${id}`)),
  );

  const add = async (files: File[]) => {
    setPending((n) => n + files.length);
    await Promise.all(
      files.map((f) =>
        upload(f)
          .catch((err) =>
            toast.error(err instanceof Error ? err.message : `Could not upload ${f.name}`),
          )
          .finally(() => setPending((n) => n - 1)),
      ),
    );
    onChange();
  };

  return (
    <section
      className={`mt-8 ${dragging ? 'outline outline-1 outline-primary outline-offset-4' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        add([...e.dataTransfer.files]);
      }}
    >
      <div className="mb-2 flex items-center gap-3">
        <div className="section-label flex-1">
          Attachments
          {pending > 0 && <span className="text-muted">uploading {pending}…</span>}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => input.current?.click()}
        >
          <Plus size={12} /> Attach
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            add([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>
      {issue.attachments.map((att) => (
        <AttachmentRow
          key={att.id}
          att={att}
          canRemove={att.uploaderId === ws.me.id || ws.canAdminTeam(issue.teamId)}
          onRemove={() => remove.mutate(att.id, { onSuccess: onChange })}
        />
      ))}
      {issue.attachments.length === 0 && (
        <p className="px-2 font-mono text-[12px] text-index">
          // drop files here, or paste them into the description
        </p>
      )}
    </section>
  );
}

function AttachmentRow({
  att,
  canRemove,
  onRemove,
}: {
  att: Attachment;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const ws = useWorkspace();
  const uploader = att.uploaderId ? ws.memberById.get(att.uploaderId) : undefined;
  const image = att.contentType.startsWith('image/');
  return (
    <div className="row group flex h-10 items-center gap-2.5 border-b border-border-soft/60 px-2">
      {image ? (
        <img
          src={att.url}
          alt=""
          className="h-7 w-7 flex-none border border-border-soft object-cover"
        />
      ) : (
        <span className="flex h-7 w-7 flex-none items-center justify-center text-index">
          <Paperclip size={14} />
        </span>
      )}
      <a
        href={att.url}
        target="_blank"
        rel="noopener"
        className="min-w-0 flex-1 truncate text-[13.5px] hover:text-highlight"
        title={att.filename}
      >
        {att.filename}
      </a>
      <span className="hidden flex-none font-mono text-[11px] text-index sm:inline">
        {[fileSize(att.size), uploader?.name, relativeTime(att.createdAt)]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {canRemove && (
        <button
          type="button"
          className="flex h-6 w-6 flex-none items-center justify-center text-index opacity-0 group-hover:opacity-100 hover:text-text focus:opacity-100"
          onClick={onRemove}
          aria-label={`Remove ${att.filename}`}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
