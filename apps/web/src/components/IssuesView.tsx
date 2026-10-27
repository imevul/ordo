import {
  type CreateIssueInput,
  DEFAULT_ISSUE_DISPLAY,
  type Issue,
  type IssueDisplay,
  type IssueFilter,
  type UpdateIssueInput,
  type View,
} from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChartColumn, Plus, Save, Trash2, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, wsPath } from '../api/client.ts';
import {
  invalidateIssues,
  useBatchUpdateIssues,
  useIssues,
  useTrashIssues,
  useUpdateIssue,
  useWsMutation,
} from '../api/queries.ts';
import { useHotkey } from '../lib/hotkeys.ts';
import { groupIssues, type IssueGroup, patchForGroup, visibleIssues } from '../lib/issues.ts';
import { readPref, ui, writePref } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { DisplayOptions, LayoutToggle } from './DisplayOptions.tsx';
import { FilterButton, FilterChips, hasUserFilters } from './FilterBar.tsx';
import { InsightsPanel } from './InsightsPanel.tsx';
import { IssueBoard } from './IssueBoard.tsx';
import { IssueList } from './IssueList.tsx';
import { EmptyState, PageHeader, Spinner } from './PageHeader.tsx';
import { SaveViewModal } from './SaveViewModal.tsx';

interface Props {
  kicker: ReactNode;
  title: ReactNode;
  /** Fixed scope of this screen (team, project, cycle…); user filters narrow it further. */
  baseFilter: IssueFilter;
  teamId?: string;
  storageKey: string;
  defaultDisplay?: Partial<IssueDisplay>;
  createDefaults?: Partial<CreateIssueInput>;
  view?: View;
  actions?: ReactNode;
  tabs?: ReactNode;
  /** A time box (cycle): the insights panel shows a burn-up across it. */
  burn?: { from: string; to: string };
  /** Open the insights panel until the person closes it (remembered per screen). */
  insightsOpen?: boolean;
  emptyTitle?: string;
  emptyBody?: ReactNode;
}

export function IssuesView(props: Props) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { baseFilter, teamId, storageKey, view } = props;

  const [userFilter, setUserFilter] = useState<IssueFilter>(() =>
    view ? view.filters : readPref(`filter:${storageKey}`, {}),
  );
  const [display, setDisplay] = useState<IssueDisplay>(() =>
    view
      ? view.display
      : {
          ...DEFAULT_ISSUE_DISPLAY,
          ...props.defaultDisplay,
          ...readPref(`display:${storageKey}`, {}),
        },
  );
  useEffect(() => {
    if (view) {
      setUserFilter(view.filters);
      setDisplay(view.display);
    }
  }, [view]);
  useEffect(() => {
    if (!view) writePref(`display:${storageKey}`, display);
  }, [display, storageKey, view]);
  useEffect(() => {
    if (!view) writePref(`filter:${storageKey}`, userFilter);
  }, [userFilter, storageKey, view]);

  const filter = useMemo(() => ({ ...userFilter, ...baseFilter }), [userFilter, baseFilter]);
  const { data, isLoading } = useIssues(ws.slug, filter);
  const issues = useMemo(() => visibleIssues(ws, data ?? [], display), [ws, data, display]);
  const groups = useMemo(
    () => groupIssues(ws, issues, display, teamId),
    [ws, issues, display, teamId],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(readPref<string[]>(`collapsed:${storageKey}`, [])),
  );
  const flat = useMemo(
    () =>
      display.layout === 'list'
        ? groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.issues)
        : groups.flatMap((g) => g.issues),
    [groups, collapsed, display.layout],
  );

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [insights, setInsights] = useState(() =>
    readPref(`insights:${storageKey}`, props.insightsOpen ?? false),
  );
  const toggleInsights = (open: boolean) => {
    setInsights(open);
    writePref(`insights:${storageKey}`, open);
  };

  const update = useUpdateIssue(ws.slug);
  const batch = useBatchUpdateIssues(ws.slug);
  const trash = useTrashIssues(ws.slug);

  const targets = useMemo(
    () => (selected.size ? [...selected] : focusedId ? [focusedId] : []),
    [selected, focusedId],
  );
  useEffect(() => {
    ui.set({ contextIssues: targets });
    return () => ui.set({ contextIssues: [] });
  }, [targets]);

  const onPatch = useCallback(
    (issue: Issue, patch: UpdateIssueInput) => update.mutate({ id: issue.id, patch }),
    [update],
  );

  const toggleSelect = (id: string, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && anchor) {
        const a = flat.findIndex((i) => i.id === anchor);
        const b = flat.findIndex((i) => i.id === id);
        if (a >= 0 && b >= 0)
          for (const i of flat.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(i.id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
  };

  const move = (delta: number) => {
    if (flat.length === 0) return;
    const idx = flat.findIndex((i) => i.id === focusedId);
    const next = flat[Math.max(0, Math.min(flat.length - 1, idx < 0 ? 0 : idx + delta))]!;
    setFocusedId(next.id);
    document.querySelector(`[data-issue-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const trashTargets = (ids: string[]) => {
    if (!ids.length) return;
    trash.mutate(ids, {
      onSuccess: () =>
        toast(`${ids.length} issue${ids.length > 1 ? 's' : ''} moved to trash`, {
          action: {
            label: 'Undo',
            onClick: async () => {
              await Promise.all(
                ids.map((id) => api.post(wsPath(ws.slug, `/issues/${id}/restore`))),
              );
              invalidateIssues(qc, ws.slug);
            },
          },
        }),
    });
    setSelected(new Set());
  };

  useHotkey(['j', 'arrowdown'], () => move(1));
  useHotkey(['k', 'arrowup'], () => move(-1));
  useHotkey('x', () => focusedId && toggleSelect(focusedId, false));
  useHotkey('shift+x', () => focusedId && toggleSelect(focusedId, true));
  useHotkey(['enter', 'o'], () => {
    const issue = flat.find((i) => i.id === focusedId);
    if (issue)
      navigate({
        to: '/$slug/issue/$identifier',
        params: { slug: ws.slug, identifier: issue.identifier },
      });
  });
  useHotkey('escape', () => setSelected(new Set()), { enabled: selected.size > 0 });
  useHotkey('mod+a', () => setSelected(new Set(flat.map((i) => i.id))));
  useHotkey('s', () => targets.length && ui.openPalette('status', targets));
  useHotkey('p', () => targets.length && ui.openPalette('priority', targets));
  useHotkey('a', () => targets.length && ui.openPalette('assignee', targets));
  useHotkey('l', () => targets.length && ui.openPalette('labels', targets));
  useHotkey('shift+p', () => targets.length && ui.openPalette('project', targets));
  useHotkey('shift+c', () => targets.length && ui.openPalette('cycle', targets));
  useHotkey('e', () => targets.length && ui.openPalette('estimate', targets));
  useHotkey('i', () => {
    if (!targets.length) return;
    const allMine = targets.every((id) => flat.find((i) => i.id === id)?.assigneeId === ws.me.id);
    batch.mutate({ ids: targets, patch: { assigneeId: allMine ? null : ws.me.id } });
  });
  useHotkey(['mod+backspace', 'delete'], () => trashTargets(targets));
  useHotkey('v', () =>
    setDisplay((d) => ({ ...d, layout: d.layout === 'list' ? 'board' : 'list' })),
  );

  const createInGroup = (g: IssueGroup) => {
    const defaults: Partial<CreateIssueInput> = {
      teamId: teamId ?? ws.myTeams[0]?.id,
      ...props.createDefaults,
    };
    const fake = { teamId: defaults.teamId ?? '', stateId: '' } as Issue;
    const patch = patchForGroup(ws, display.groupBy, g, fake);
    ui.openCreateIssue({ ...defaults, ...(patch as Partial<CreateIssueInput>) });
  };

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writePref(`collapsed:${storageKey}`, [...next]);
      return next;
    });

  const updateView = useWsMutation(
    ws.slug,
    (v: { filters: IssueFilter; display: IssueDisplay }) =>
      api.patch(wsPath(ws.slug, `/views/${view!.id}`), v),
    {
      success: 'View saved',
    },
  );
  const viewDirty =
    view &&
    (JSON.stringify(view.filters) !== JSON.stringify(userFilter) ||
      JSON.stringify(view.display) !== JSON.stringify(display));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        kicker={props.kicker}
        title={props.title}
        actions={
          <>
            {props.actions}
            {view && viewDirty && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => updateView.mutate({ filters: userFilter, display })}
              >
                <Save size={13} /> Save
              </button>
            )}
            {!view && !ws.isGuest && hasUserFilters(userFilter) && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setSaveOpen(true)}
              >
                <Save size={13} />
                <span className="hidden sm:inline">Save view</span>
              </button>
            )}
            <button
              type="button"
              className={`btn btn-ghost btn-sm ${insights ? 'text-primary' : ''}`}
              aria-pressed={insights}
              onClick={() => toggleInsights(!insights)}
              title="Insights"
            >
              <ChartColumn size={13} />
              <span className="hidden lg:inline">Insights</span>
            </button>
            <FilterButton filter={userFilter} onChange={setUserFilter} teamId={teamId} />
            <DisplayOptions display={display} onChange={setDisplay} />
            <LayoutToggle display={display} onChange={setDisplay} />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() =>
                ui.openCreateIssue({ teamId: teamId ?? ws.myTeams[0]?.id, ...props.createDefaults })
              }
              aria-label="New issue"
            >
              <Plus size={13} />
              <span className="hidden md:inline">New</span>
            </button>
          </>
        }
      >
        {props.tabs}
        <FilterChips filter={userFilter} onChange={setUserFilter} teamId={teamId} />
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {isLoading && !data ? (
            <Spinner label="loading issues" />
          ) : issues.length === 0 ? (
            <EmptyState
              title={props.emptyTitle ?? 'nothing here'}
              body={
                props.emptyBody ??
                (hasUserFilters(userFilter)
                  ? 'No issues match these filters.'
                  : 'Create an issue to get started.')
              }
              action={
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() =>
                    ui.openCreateIssue({
                      teamId: teamId ?? ws.myTeams[0]?.id,
                      ...props.createDefaults,
                    })
                  }
                >
                  New issue <span className="arrow">→</span>
                </button>
              }
            />
          ) : display.layout === 'board' ? (
            <div className="min-h-0 flex-1">
              <IssueBoard
                groups={groups}
                groupBy={display.groupBy}
                manualOrder={display.orderBy === 'manual'}
                focusedId={focusedId}
                selected={selected}
                onPatch={onPatch}
                onFocus={setFocusedId}
                onCreateInGroup={createInGroup}
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              <IssueList
                groups={groups}
                flat={flat}
                groupKind={display.groupBy}
                focusedId={focusedId}
                selected={selected}
                collapsed={collapsed}
                onToggleCollapse={toggleCollapse}
                onPatch={onPatch}
                onFocus={setFocusedId}
                onToggleSelect={toggleSelect}
                onCreateInGroup={createInGroup}
              />
            </div>
          )}
        </div>
        {insights && data && (
          <InsightsPanel issues={data} burn={props.burn} onClose={() => toggleInsights(false)} />
        )}
      </div>

      {selected.size > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
          <div className="panel panel-sm panel-raised pointer-events-auto flex items-center gap-1 p-1.5 pl-3">
            <span className="mr-2 font-mono text-[12px]">
              <span className="text-primary">{selected.size}</span> selected
            </span>
            {(['status', 'priority', 'assignee', 'labels', 'project'] as const).map((page) => (
              <button
                type="button"
                key={page}
                className="btn btn-ghost btn-sm"
                onClick={() => ui.openPalette(page, [...selected])}
              >
                {page}
              </button>
            ))}
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => trashTargets([...selected])}
              aria-label="Move to trash"
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              className="ml-1 flex h-7 w-7 items-center justify-center text-index hover:text-text"
              onClick={() => setSelected(new Set())}
              aria-label="Clear selection"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      <SaveViewModal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        filters={filter}
        display={display}
        teamId={teamId}
      />
    </div>
  );
}
