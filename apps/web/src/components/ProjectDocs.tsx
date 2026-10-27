import type { Project, ProjectDocument } from '@ordo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { FileText, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../api/client.ts';
import { useWsMutation } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { relativeTime } from '../lib/format.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { Markdown } from './Markdown.tsx';
import { MarkdownEditor } from './MarkdownEditor.tsx';
import { confirmDialog } from './ui/Modal.tsx';

const SAVE_AFTER_MS = 1000;

/** A project's documents: a list, and the open one, always editable. */
export function ProjectDocs({ project, docId }: { project: Project; docId?: string }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { data: docs = [] } = useQuery({
    queryKey: ['ws', ws.slug, 'documents', project.id],
    queryFn: () => api.get<ProjectDocument[]>(wsPath(ws.slug, `/projects/${project.id}/documents`)),
  });
  const open = (id: string) =>
    navigate({
      to: '/$slug/project/$projectId',
      params: { slug: ws.slug, projectId: project.id },
      search: { tab: 'docs', doc: id },
    });
  const create = useWsMutation(
    ws.slug,
    () =>
      api.post<ProjectDocument>(wsPath(ws.slug, `/projects/${project.id}/documents`), {
        title: t('projects.docs.untitled'),
      }),
    { invalidate: [['ws', ws.slug, 'documents']] },
  );
  const current = docId ?? docs[0]?.id;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-60 flex-none flex-col border-r border-border-soft">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <span className="section-label flex-1">{t('projects.docs.title')}</span>
          {!ws.isGuest && (
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center text-index hover:text-text"
              onClick={() => create.mutate(undefined, { onSuccess: (d) => open(d.id) })}
              aria-label={t('projects.docs.newDocument')}
            >
              <Plus size={14} />
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {docs.map((d) => (
            <Link
              key={d.id}
              to="/$slug/project/$projectId"
              params={{ slug: ws.slug, projectId: project.id }}
              search={{ tab: 'docs', doc: d.id }}
              className="nav-item mx-1.5"
              data-status={d.id === current ? 'active' : undefined}
            >
              <FileText size={14} />
              <span className="truncate">{d.title}</span>
            </Link>
          ))}
          {docs.length === 0 && (
            <p className="px-3 font-mono text-[12px] text-index">{t('projects.docs.empty')}</p>
          )}
        </div>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {current ? (
          <DocumentEditor
            key={current}
            id={current}
            onDeleted={() =>
              navigate({
                to: '/$slug/project/$projectId',
                params: { slug: ws.slug, projectId: project.id },
                search: { tab: 'docs' },
              })
            }
          />
        ) : (
          <div className="mx-auto max-w-xl px-6 py-16 text-center">
            <p className="text-muted">
              {t('projects.docs.intro')} {ws.isGuest ? '' : t('projects.docs.start')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict';

/**
 * Edits one document in place and saves a second after typing stops. A save based on an older
 * version than the server's is refused (409); then the person chooses whose version to keep.
 */
function DocumentEditor({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const key = ['ws', ws.slug, 'document', id];
  const { data: doc } = useQuery({
    queryKey: key,
    queryFn: () => api.get<ProjectDocument>(wsPath(ws.slug, `/documents/${id}`)),
  });
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [state, setState] = useState<SaveState>('saved');
  const base = useRef<string | null>(null);
  const edits = useRef(0);
  const readOnly = ws.isGuest;

  // Take the server's version when there's nothing unsaved here.
  useEffect(() => {
    if (!doc || state !== 'saved') return;
    setTitle(doc.title);
    setContent(doc.content ?? '');
    base.current = doc.updatedAt;
  }, [doc, state]);

  const save = async (force = false) => {
    const sent = edits.current;
    setState('saving');
    try {
      const saved = await api.patch<ProjectDocument>(wsPath(ws.slug, `/documents/${id}`), {
        title: title.trim() || t('projects.docs.untitled'),
        content,
        ...(force ? {} : { baseUpdatedAt: base.current }),
      });
      base.current = saved.updatedAt;
      qc.setQueryData(key, saved);
      qc.invalidateQueries({ queryKey: ['ws', ws.slug, 'documents'] });
      // More typing while this was in flight: the next save picks it up.
      setState(edits.current === sent ? 'saved' : 'dirty');
    } catch (err) {
      if ((err as { status?: number }).status === 409) setState('conflict');
      else {
        setState('dirty');
        toast.error(err instanceof Error ? err.message : t('projects.docs.saveFailed'));
      }
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: save after each pause in typing
  useEffect(() => {
    if (state !== 'dirty') return;
    const timer = setTimeout(() => save(), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [state, title, content]);

  const change = (patch: { title?: string; content?: string }) => {
    edits.current++;
    if (patch.title !== undefined) setTitle(patch.title);
    if (patch.content !== undefined) setContent(patch.content);
    if (state !== 'conflict') setState('dirty');
  };

  const remove = useWsMutation(ws.slug, () => api.del(wsPath(ws.slug, `/documents/${id}`)), {
    invalidate: [['ws', ws.slug, 'documents']],
  });

  if (!doc) return null;
  const editor = doc.updatedById ? ws.memberById.get(doc.updatedById) : null;
  const status =
    state === 'saving'
      ? t('projects.docs.saving')
      : state === 'dirty'
        ? t('projects.docs.unsaved')
        : editor
          ? t('projects.docs.editedBy', { time: relativeTime(doc.updatedAt), name: editor.name })
          : t('projects.docs.edited', { time: relativeTime(doc.updatedAt) });

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {state === 'conflict' && (
        <div className="panel panel-sm mb-5 flex flex-wrap items-center gap-3 border-warning p-3 text-[13px]">
          <span className="flex-1">{t('projects.docs.conflict')}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setState('saved');
              qc.invalidateQueries({ queryKey: key });
            }}
          >
            {t('projects.docs.loadTheirs')}
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => save(true)}>
            {t('projects.docs.keepMine')}
          </button>
        </div>
      )}
      <div className="flex items-start gap-3">
        <input
          value={title}
          disabled={readOnly}
          onChange={(e) => change({ title: e.target.value })}
          className="min-w-0 flex-1 bg-transparent text-[28px] font-bold tracking-[-0.02em] outline-none"
          aria-label={t('projects.docs.titleLabel')}
        />
        {!readOnly && (
          <button
            type="button"
            className="btn btn-ghost btn-sm mt-2"
            aria-label={t('projects.docs.delete')}
            onClick={async () => {
              if (
                await confirmDialog({
                  title: t('projects.docs.confirmDeleteTitle', { title: doc.title }),
                  danger: true,
                })
              )
                remove.mutate(undefined, { onSuccess: onDeleted });
            }}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
      <div className="mt-1 mb-5 font-mono text-[11px] text-index">{status}</div>
      {readOnly ? (
        <Markdown source={content} />
      ) : (
        <MarkdownEditor
          bare
          value={content}
          onChange={(v) => change({ content: v })}
          placeholder={t('projects.docs.placeholder')}
          minRows={18}
          className="-mx-3"
        />
      )}
    </div>
  );
}
