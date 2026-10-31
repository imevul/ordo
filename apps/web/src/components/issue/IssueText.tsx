import type { IssueDetail } from '@ordo/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAttachmentUpload } from '../../api/queries.ts';
import { t } from '../../i18n/index.ts';
import { useWorkspace } from '../../lib/workspace.tsx';
import { ClickToEdit } from '../ClickToEdit.tsx';
import { Markdown } from '../Markdown.tsx';
import { MarkdownEditor } from '../MarkdownEditor.tsx';

export function IssueTitle({
  issue,
  onSave,
}: {
  issue: IssueDetail;
  onSave: (title: string) => void;
}) {
  const [value, setValue] = useState(issue.title);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setValue(issue.title), [issue.title]);
  const resize = () => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = `${ref.current.scrollHeight}px`;
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize whenever the text changes
  useLayoutEffect(resize, [value]);
  // The text also re-wraps when the width changes (resize, rotation, sidebar) or the web font
  // loads. Only react to width: our own height change fires the observer too and would loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: set up once; resize reads the ref
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      resize();
    });
    observer.observe(el);
    let alive = true;
    document.fonts.ready.then(() => alive && resize());
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, []);
  const commit = () => {
    const next = value.trim();
    if (next && next !== issue.title) onSave(next);
    else setValue(issue.title);
  };
  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          setValue(issue.title);
          e.currentTarget.blur();
        }
      }}
      className="w-full resize-none overflow-hidden bg-transparent text-[24px] leading-tight font-bold tracking-[-0.02em] outline-none"
      aria-label={t('issue.detail.titleLabel')}
    />
  );
}

export function IssueDescription({
  issue,
  onSave,
}: {
  issue: IssueDetail;
  onSave: (d: string) => void;
}) {
  const ws = useWorkspace();
  const upload = useAttachmentUpload(ws.slug, issue.id);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(issue.description);
  useEffect(() => {
    if (!editing) setValue(issue.description);
  }, [issue.description, editing]);
  const save = () => {
    if (value !== issue.description) onSave(value);
    setEditing(false);
  };
  return (
    <ClickToEdit
      editing={editing}
      onEdit={() => setEditing(true)}
      className="mt-4 min-h-12"
      editor={
        <div className="mt-4">
          <MarkdownEditor
            value={value}
            onChange={setValue}
            onSubmit={save}
            onCancel={() => setEditing(false)}
            autoFocus
            minRows={6}
            placeholder={t('issue.detail.addDescription')}
            onUpload={upload}
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setEditing(false)}
            >
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={save}>
              {t('common.save')}
            </button>
          </div>
        </div>
      }
    >
      {issue.description.trim() ? (
        <Markdown source={issue.description} />
      ) : (
        <p className="text-[14px] text-index">{t('issue.detail.addDescription')}</p>
      )}
    </ClickToEdit>
  );
}
