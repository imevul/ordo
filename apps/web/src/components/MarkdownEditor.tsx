import type { Attachment } from '@ordo/shared';
import { Paperclip } from 'lucide-react';
import {
  type KeyboardEvent,
  lazy,
  type Ref,
  Suspense,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { attachmentMarkdown } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { richTextUnsafe } from '../lib/markdown.ts';
import { readPref, writePref } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Markdown } from './Markdown.tsx';
import type { EditorHandle } from './RichTextEditor.tsx';
import { Avatar } from './ui/Avatar.tsx';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  minRows?: number;
  className?: string;
  bare?: boolean;
  /** Enables pasting, dropping and picking files; see useAttachmentUpload. */
  onUpload?: (file: File) => Promise<Attachment>;
}

type Mode = 'rich' | 'markdown';

// TipTap is about a third of the app's code; load it on first use (and soon after start-up).
const loadRichTextEditor = () => import('./RichTextEditor.tsx');
const RichTextEditor = lazy(() =>
  loadRichTextEditor().then((m) => ({ default: m.RichTextEditor })),
);
if (typeof window !== 'undefined') setTimeout(loadRichTextEditor, 3000);

/**
 * Text editor for descriptions, comments and updates. Rich text by default; people who prefer
 * writing Markdown switch to the source view, and that choice sticks per browser. Both edit the
 * same Markdown, have @mention completion and file uploads, and submit with ⌘/Ctrl+Enter.
 */
export function MarkdownEditor(props: Props) {
  const { value, onUpload, bare, className = '' } = props;
  // Text with HTML or footnotes opens as Markdown so the rich editor can't drop them.
  const [mode, setMode] = useState<Mode>(() =>
    richTextUnsafe(value) ? 'markdown' : readPref<Mode>('editorMode', 'rich'),
  );
  const [focusOnSwitch, setFocusOnSwitch] = useState(false);
  const [preview, setPreview] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const switchMode = () => {
    const next = mode === 'rich' ? 'markdown' : 'rich';
    if (next === 'rich' && richTextUnsafe(value)) {
      toast.error(t('issue.editor.richTextUnsafe'));
      return;
    }
    writePref('editorMode', next);
    setFocusOnSwitch(true);
    setPreview(false);
    setMode(next);
  };

  return (
    <div
      className={`relative ${bare ? '' : 'border border-border bg-bg focus-within:border-primary'} ${className}`}
      onDragOver={(e) => {
        if (onUpload && e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        // The rich editor handles drops on its text itself.
        if (!onUpload || e.defaultPrevented || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        editor.current?.uploadFiles([...e.dataTransfer.files]);
      }}
    >
      {mode === 'rich' ? (
        <Suspense
          fallback={<div style={{ minHeight: `${(props.minRows ?? 3) * 1.65 + 1.25}em` }} />}
        >
          <RichTextEditor
            {...props}
            autoFocus={props.autoFocus || focusOnSwitch}
            minRows={props.minRows ?? 3}
            handle={editor}
          />
        </Suspense>
      ) : (
        <MarkdownSource
          {...props}
          autoFocus={props.autoFocus || focusOnSwitch}
          preview={preview}
          handle={editor}
        />
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border-soft px-2 py-1">
        <span className="flex items-center gap-3">
          <button
            type="button"
            className="font-mono text-[10.5px] tracking-[0.12em] text-index uppercase hover:text-muted"
            onClick={switchMode}
            title={mode === 'rich' ? t('issue.editor.editSource') : t('issue.editor.editRich')}
          >
            {mode === 'rich' ? '// markdown' : t('issue.editor.richText')}
          </button>
          {mode === 'markdown' && (
            <button
              type="button"
              className="font-mono text-[10.5px] tracking-[0.12em] text-index uppercase hover:text-muted"
              onClick={() => setPreview((p) => !p)}
            >
              {preview ? t('issue.editor.write') : t('issue.editor.preview')}
            </button>
          )}
        </span>
        <span className="flex items-center gap-2 font-mono text-[10.5px] text-index">
          {mode === 'rich' ? t('issue.editor.hintRich') : t('issue.editor.hintMarkdown')}
          {onUpload && (
            <>
              <button
                type="button"
                className="flex h-5 w-5 items-center justify-center hover:text-muted"
                onClick={() => fileInput.current?.click()}
                aria-label={t('issue.editor.attachFiles')}
                title={t('issue.editor.attachFilesTitle')}
              >
                <Paperclip size={12} />
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  editor.current?.uploadFiles([...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/** The Markdown source view: a textarea with @mention completion and pasted uploads. */
function MarkdownSource({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  autoFocus,
  minRows = 3,
  onUpload,
  preview,
  handle,
}: Props & { preview: boolean; handle: Ref<EditorHandle> }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Uploads finish after later keystrokes, so they edit the latest text through the latest onChange.
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const ws = useWorkspace();

  // biome-ignore lint/correctness/useExhaustiveDependencies: resize whenever the text or mode changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value, preview]);

  useEffect(() => {
    if (autoFocus) {
      const el = ref.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [autoFocus]);

  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return ws.members
      .filter((m) => m.username.includes(q) || m.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mention, ws.members]);

  const detectMention = (text: string, caret: number) => {
    const m = /(?:^|[\s(])@([a-z0-9._-]{0,32})$/.exec(text.slice(0, caret));
    setMention(m ? { start: caret - m[1]!.length - 1, query: m[1]! } : null);
    setActive(0);
  };

  const insertMention = (username: string) => {
    if (!mention || !ref.current) return;
    const caret = ref.current.selectionStart;
    const next = `${value.slice(0, mention.start)}@${username} ${value.slice(caret)}`;
    onChange(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = mention.start + username.length + 2;
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  const setText = (next: string) => {
    latest.current.value = next;
    latest.current.onChange(next);
  };

  useImperativeHandle(handle, () => ({ uploadFiles, focus: () => ref.current?.focus() }));

  const uploadFiles = (list: File[]) => {
    if (!onUpload || list.length === 0) return;
    let caret = ref.current?.selectionStart ?? latest.current.value.length;
    for (const file of list) {
      const token = `[${t('issue.editor.uploading', { name: file.name }).replace(/[[\]\\]/g, '')}]()`;
      const text = latest.current.value;
      const insert = `${caret > 0 && text[caret - 1] !== '\n' ? '\n' : ''}${token}\n`;
      setText(text.slice(0, caret) + insert + text.slice(caret));
      caret += insert.length;
      const replace = (from: string, to: string) => {
        if (latest.current.value.includes(from)) setText(latest.current.value.replace(from, to));
      };
      onUpload(file).then(
        (att) => replace(token, attachmentMarkdown(att)),
        (err) => {
          replace(`${token}\n`, '');
          toast.error(
            err instanceof Error ? err.message : t('issue.uploadFailed', { name: file.name }),
          );
        },
      );
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(matches[active]!.username);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit?.();
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <>
      {preview ? (
        <div className="min-h-[4.5rem] px-3 py-2.5">
          {value.trim() ? (
            <Markdown source={value} />
          ) : (
            <span className="text-index">{t('issue.editor.nothingToPreview')}</span>
          )}
        </div>
      ) : (
        <textarea
          ref={ref}
          value={value}
          rows={minRows}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            detectMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (!onUpload || e.clipboardData.files.length === 0) return;
            e.preventDefault();
            uploadFiles([...e.clipboardData.files]);
          }}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          className="block w-full resize-none overflow-hidden bg-transparent px-3 py-2.5 font-mono text-[13px] leading-relaxed outline-none placeholder:text-index"
        />
      )}
      {mention && matches.length > 0 && !preview && (
        <div className="panel panel-sm panel-raised absolute left-3 z-30 mt-1 w-64 py-1">
          {matches.map((m, i) => (
            <button
              type="button"
              key={m.id}
              className="menu-item"
              data-active={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(m.username);
              }}
            >
              <Avatar name={m.name} color={m.avatarColor} src={m.avatarUrl} size={16} />
              <span className="truncate">{m.name}</span>
              <span className="ml-auto font-mono text-[11px] text-index">@{m.username}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
