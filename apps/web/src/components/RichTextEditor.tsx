import { type Attachment, attachmentMarkdown, type Member } from '@ordo/shared';
import { type Editor, Extension } from '@tiptap/core';
import { Placeholder } from '@tiptap/extensions';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { exitSuggestion, Suggestion, type SuggestionProps } from '@tiptap/suggestion';
import { Bold, Code, Italic, Link2, Strikethrough } from 'lucide-react';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { toast } from 'sonner';
import { t } from '../i18n/index.ts';
import { markdownConverter, richTextExtensions } from '../lib/richtext.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Avatar } from './ui/Avatar.tsx';

export interface EditorHandle {
  uploadFiles(files: File[]): void;
  focus(): void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  minRows: number;
  onUpload?: (file: File) => Promise<Attachment>;
  handle: Ref<EditorHandle>;
}

const md = markdownConverter();
const mentionKey = new PluginKey('mention');
const uploadKey = new PluginKey<DecorationSet>('uploads');
const highlightKey = new PluginKey<DecorationSet>('highlights');

interface MentionMenu {
  items: Member[];
  active: number;
  left: number;
  top: number;
  command: (m: Member) => void;
}

/** Marks @mentions and issue identifiers the way the rendered Markdown will link them. */
function highlights(known: () => { usernames: Set<string>; teamKeys: Set<string> }) {
  const build = (doc: import('@tiptap/pm/model').Node) => {
    const { usernames, teamKeys } = known();
    const decos: Decoration[] = [];
    doc.descendants((node, pos, parent) => {
      if (!node.isText || parent?.type.spec.code || node.marks.some((m) => m.type.spec.code))
        return;
      const text = node.text ?? '';
      for (const m of text.matchAll(
        /(^|[\s(])(@([a-z0-9._-]{2,32})|([A-Z][A-Z0-9]{0,6})-\d+\b)/g,
      )) {
        if (m[3] ? !usernames.has(m[3]) : !teamKeys.has(m[4]!)) continue;
        const from = pos + m.index + m[1]!.length;
        decos.push(Decoration.inline(from, from + m[2]!.length, { class: 'mention' }));
      }
    });
    return DecorationSet.create(doc, decos);
  };
  return new Plugin<DecorationSet>({
    key: highlightKey,
    state: {
      init: (_, state) => build(state.doc),
      apply: (tr, set) => (tr.docChanged || tr.getMeta(highlightKey) ? build(tr.doc) : set),
    },
    props: { decorations: (state) => highlightKey.getState(state) },
  });
}

/** Shows "Uploading …" where each file will land, and keeps that spot as the text changes. */
const uploadPlaceholders = new Plugin<DecorationSet>({
  key: uploadKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      let next = set.map(tr.mapping, tr.doc);
      const action = tr.getMeta(uploadKey) as
        | { add: { id: string; pos: number; name: string } }
        | { remove: string }
        | undefined;
      if (action && 'add' in action) {
        const el = document.createElement('span');
        el.className = 'upload-placeholder';
        el.textContent = t('issue.editor.uploading', { name: action.add.name });
        next = next.add(tr.doc, [Decoration.widget(action.add.pos, el, { id: action.add.id })]);
      } else if (action) {
        next = next.remove(next.find(undefined, undefined, (spec) => spec.id === action.remove));
      }
      return next;
    },
  },
  props: { decorations: (state) => uploadKey.getState(state) },
});

function placeholderPos(view: EditorView, id: string) {
  return uploadKey.getState(view.state)?.find(undefined, undefined, (s) => s.id === id)[0]?.from;
}

/**
 * WYSIWYG editing of Markdown: what is typed is shown formatted, Markdown shortcuts ("## ", "- ",
 * "**bold**") format as you type, and every change is written back as Markdown.
 */
export function RichTextEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  autoFocus,
  minRows,
  onUpload,
  handle,
}: Props) {
  const ws = useWorkspace();
  const props = useRef({ onChange, onSubmit, onCancel, onUpload });
  props.current = { onChange, onSubmit, onCancel, onUpload };
  const known = useRef({
    usernames: new Set<string>(),
    teamKeys: new Set<string>(),
    members: ws.members,
  });
  known.current = {
    usernames: new Set(ws.members.map((m) => m.username)),
    teamKeys: new Set(ws.teams.map((team) => team.key)),
    members: ws.members,
  };
  // The Markdown this editor last produced, so echoes of our own onChange don't reset the content.
  const emitted = useRef(value);
  const wrapper = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [menu, setMenu] = useState<MentionMenu | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;

  const editor = useEditor({
    extensions: [
      ...richTextExtensions(),
      Placeholder.configure({ placeholder: placeholder ?? '' }),
      Extension.create({
        name: 'ordo',
        addProseMirrorPlugins() {
          return [
            highlights(() => known.current),
            uploadPlaceholders,
            Suggestion<Member, Member>({
              editor: this.editor,
              pluginKey: mentionKey,
              char: '@',
              allowedPrefixes: [' ', '('],
              items: ({ query }) => {
                const q = query.toLowerCase();
                return known.current.members
                  .filter((m) => m.username.includes(q) || m.name.toLowerCase().includes(q))
                  .slice(0, 6);
              },
              command: ({ editor, range, props: m }) => {
                // Mentions stay plain "@username" text, as in Markdown.
                editor.chain().focus().insertContentAt(range, `@${m.username} `).run();
              },
              render: () => {
                const show = (p: SuggestionProps<Member, Member>) => {
                  const rect = p.clientRect?.();
                  const box = wrapper.current?.getBoundingClientRect();
                  if (!rect || !box || p.items.length === 0) return setMenu(null);
                  setMenu((prev) => ({
                    items: p.items,
                    active: Math.min(prev?.active ?? 0, p.items.length - 1),
                    left: rect.left - box.left,
                    top: rect.bottom - box.top + 4,
                    command: p.command,
                  }));
                };
                return {
                  onStart: show,
                  onUpdate: show,
                  onExit: () => setMenu(null),
                  onKeyDown: ({ event, view }) => {
                    const m = menuRef.current;
                    if (!m) return false;
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      const step = event.key === 'ArrowDown' ? 1 : m.items.length - 1;
                      setMenu({ ...m, active: (m.active + step) % m.items.length });
                      return true;
                    }
                    if (event.key === 'Enter' || event.key === 'Tab') {
                      m.command(m.items[m.active]!);
                      return true;
                    }
                    if (event.key === 'Escape') {
                      exitSuggestion(view, mentionKey);
                      return true;
                    }
                    return false;
                  },
                };
              },
            }),
          ];
        },
      }),
    ],
    content: md.parse(value),
    autofocus: autoFocus ? 'end' : false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      handleDOMEvents: {
        // ProseMirror swallows Escape; without a cancel action it belongs to the page (closing a
        // modal), unless the mention menu wants it.
        keydown: (view, e) =>
          e.key === 'Escape' && !props.current.onCancel && !mentionKey.getState(view.state)?.active,
      },
      attributes: {
        class: 'prose-ordo rich-editor',
        style: `min-height: ${minRows * 1.65 + 1.25}em`,
      },
      handleKeyDown: (_view, e) => {
        if (menuRef.current) return false;
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && props.current.onSubmit) {
          props.current.onSubmit();
          return true;
        }
        if (e.key === 'Escape' && props.current.onCancel) {
          props.current.onCancel();
          return true;
        }
        return false;
      },
      handlePaste: (view, e) => {
        const files = [...(e.clipboardData?.files ?? [])];
        if (!props.current.onUpload || files.length === 0) return false;
        upload(view, files, view.state.selection.from);
        return true;
      },
      handleDrop: (view, e, _slice, moved) => {
        const files = [...(e.dataTransfer?.files ?? [])];
        if (moved || !props.current.onUpload || files.length === 0) return false;
        const at = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos;
        upload(view, files, at ?? view.state.selection.from);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      const next = md.serialize(editor.getJSON());
      if (next === emitted.current) return;
      emitted.current = next;
      props.current.onChange(next);
    },
  });
  editorRef.current = editor;

  function upload(view: EditorView, files: File[], pos: number) {
    const send = props.current.onUpload;
    if (!send) return;
    for (const file of files) {
      const id = crypto.randomUUID();
      view.dispatch(view.state.tr.setMeta(uploadKey, { add: { id, pos, name: file.name } }));
      send(file).then(
        (att) => {
          if (view.isDestroyed) return;
          const at = placeholderPos(view, id);
          view.dispatch(view.state.tr.setMeta(uploadKey, { remove: id }));
          const ed = editorRef.current;
          if (at === undefined || !ed || ed.isDestroyed) return;
          const inline = md.parse(attachmentMarkdown(att)).content?.[0]?.content ?? [];
          ed.chain()
            .insertContentAt(at, [...inline, { type: 'text', text: ' ' }])
            .run();
        },
        (err) => {
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(uploadKey, { remove: id }));
          toast.error(
            err instanceof Error ? err.message : t('issue.uploadFailed', { name: file.name }),
          );
        },
      );
    }
  }

  useImperativeHandle(handle, () => ({
    uploadFiles: (files) => editor && upload(editor.view, files, editor.state.selection.from),
    focus: () => editor?.commands.focus('end'),
  }));

  // Text replaced from outside (cleared after sending, reset on cancel).
  useEffect(() => {
    if (!editor || value === emitted.current) return;
    emitted.current = value;
    editor.commands.setContent(md.parse(value), { emitUpdate: false });
  }, [value, editor]);

  // Members load after the editor; refresh the highlights once they do.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the workspace lists change
  useEffect(() => {
    if (editor && !editor.isDestroyed)
      editor.view.dispatch(editor.state.tr.setMeta(highlightKey, true));
  }, [editor, ws.members, ws.teams]);

  return (
    <div ref={wrapper} className="relative">
      <EditorContent editor={editor} />
      {editor && <FormatBubble editor={editor} />}
      {menu && (
        <div
          className="panel panel-sm panel-raised absolute z-30 w-64 py-1"
          style={{ left: Math.max(0, menu.left - 8), top: menu.top }}
        >
          {menu.items.map((m, i) => (
            <button
              type="button"
              key={m.id}
              className="menu-item"
              data-active={i === menu.active}
              onMouseDown={(e) => {
                e.preventDefault();
                menu.command(m);
              }}
            >
              <Avatar name={m.name} color={m.avatarColor} src={m.avatarUrl} size={16} />
              <span className="truncate">{m.name}</span>
              <span className="ml-auto font-mono text-[11px] text-index">@{m.username}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const LINK = /^(https?:\/\/|mailto:|\/)/i;

/** Formatting for selected text: bold, italic, strikethrough, inline code and links. */
function FormatBubble({ editor }: { editor: Editor }) {
  const [link, setLink] = useState<string | null>(null);
  // The bubble stays up while its link field has focus.
  const linking = useRef(false);
  linking.current = link !== null;
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      href: (e.getAttributes('link').href as string | undefined) ?? '',
    }),
  });
  const buttons = [
    {
      key: 'bold',
      icon: Bold,
      label: t('issue.editor.bold'),
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      key: 'italic',
      icon: Italic,
      label: t('issue.editor.italic'),
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      key: 'strike',
      icon: Strikethrough,
      label: t('issue.editor.strike'),
      run: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      key: 'code',
      icon: Code,
      label: t('issue.editor.code'),
      run: () => editor.chain().focus().toggleCode().run(),
    },
  ] as const;

  const applyLink = () => {
    const href = (link ?? '').trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!href) chain.unsetLink().run();
    else if (LINK.test(href) || /^[\w-]+(\.[\w-]+)+/.test(href)) {
      chain.setLink({ href: LINK.test(href) ? href : `https://${href}` }).run();
    } else return toast.error(t('issue.editor.badLink'));
    setLink(null);
  };

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: 'top', offset: 6 }}
      shouldShow={({ editor: e, from, to }) =>
        linking.current ||
        (e.isFocused && from !== to && !e.isActive('codeBlock') && !e.isActive('image'))
      }
      className="panel panel-sm panel-raised z-40 flex items-center p-0.5"
    >
      {link === null ? (
        <>
          {buttons.map(({ key, icon: Icon, label, run }) => (
            <button
              key={key}
              type="button"
              className="flex h-7 w-7 items-center justify-center text-muted hover:bg-bg hover:text-text data-[on=true]:text-primary"
              data-on={state[key]}
              title={label}
              aria-label={label}
              aria-pressed={state[key]}
              onClick={run}
            >
              <Icon size={14} />
            </button>
          ))}
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center text-muted hover:bg-bg hover:text-text data-[on=true]:text-primary"
            data-on={state.link}
            title={t('issue.editor.link')}
            aria-label={t('issue.editor.link')}
            onClick={() => setLink(state.href)}
          >
            <Link2 size={14} />
          </button>
        </>
      ) : (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink();
          }}
        >
          <input
            autoFocus
            className="w-56 bg-transparent px-2 py-1 font-mono text-[12px] outline-none placeholder:text-index"
            placeholder={t('issue.editor.linkPlaceholder')}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setLink(null);
                editor.commands.focus();
              }
            }}
          />
          <button type="submit" className="btn btn-ghost btn-sm">
            {t('issue.editor.setLink')}
          </button>
        </form>
      )}
    </BubbleMenu>
  );
}
