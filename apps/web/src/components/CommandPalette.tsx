import type { Issue, UpdateIssueInput } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import {
  ArrowRight,
  Copy,
  Eye,
  Hexagon,
  Inbox,
  Keyboard,
  Layers,
  LogOut,
  Plus,
  Search,
  Settings,
  Target,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api/client.ts';
import { useBatchUpdateIssues, useSearch, useTrashIssues } from '../api/queries.ts';
import { useHotkeyScope } from '../lib/hotkeys.ts';
import { type PalettePage, ui, useUi } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { StatusIcon, TeamIcon } from './icons.tsx';
import {
  assigneeOptions,
  cycleOptions,
  estimateOptions,
  labelOptions,
  patchFor,
  priorityOptions,
  projectOptions,
  statusOptions,
  teamOptions,
} from './properties.tsx';
import { Modal } from './ui/Modal.tsx';
import type { Option } from './ui/OptionList.tsx';

const PAGE_TITLES: Record<Exclude<PalettePage, 'root'>, string> = {
  status: 'Change status',
  priority: 'Set priority',
  assignee: 'Assign to',
  labels: 'Labels',
  project: 'Set project',
  cycle: 'Set cycle',
  estimate: 'Set estimate',
  team: 'Move to team',
};

export function CommandPalette() {
  const page = useUi((s) => s.palette);
  const targets = useUi((s) => s.paletteTargets);
  const ws = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const batch = useBatchUpdateIssues(ws.slug);
  const trash = useTrashIssues(ws.slug);
  const [query, setQuery] = useState('');
  useHotkeyScope('palette', page !== null);
  const search = useSearch(ws.slug, page === 'root' && query.trim().length >= 2 ? query : '');

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the query whenever the page changes
  useEffect(() => setQuery(''), [page]);

  // Look up target issues in any cached list so pages can show the current value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read the query cache each time the palette opens or changes page
  const targetIssues = useMemo(() => {
    const found = new Map<string, Issue>();
    for (const [, list] of qc.getQueriesData<Issue[] | Issue>({ queryKey: ['ws', ws.slug] })) {
      const items = Array.isArray(list) ? list : list && 'identifier' in list ? [list] : [];
      for (const i of items) if (targets.includes(i.id)) found.set(i.id, i);
    }
    return [...found.values()];
  }, [qc, targets, ws.slug, page]);

  if (page === null) return null;
  const close = () => ui.set({ palette: null });
  const go = (to: string) => {
    close();
    navigate({ to });
  };
  const teamId = targetIssues[0]?.teamId ?? ws.myTeams[0]?.id ?? '';
  const sameTeam = targetIssues.every((i) => i.teamId === teamId);

  const apply = (patch: UpdateIssueInput, keepOpen = false) => {
    if (!targets.length) return;
    batch.mutate({ ids: targets, patch });
    if (!keepOpen) close();
  };

  const subOptions = (): Option[] => {
    switch (page) {
      case 'status':
        return sameTeam ? statusOptions(ws, teamId) : [];
      case 'priority':
        return priorityOptions();
      case 'assignee':
        return assigneeOptions(ws);
      case 'labels':
        return labelOptions(ws, sameTeam ? teamId : undefined);
      case 'project':
        return projectOptions(ws);
      case 'cycle':
        return sameTeam ? cycleOptions(ws, teamId) : [];
      case 'estimate':
        return sameTeam ? estimateOptions(ws, teamId) : [];
      case 'team':
        return teamOptions(ws);
      default:
        return [];
    }
  };

  const current = (o: Option) => {
    const i = targetIssues[0];
    if (!i || targetIssues.length > 1) return false;
    switch (page) {
      case 'status':
        return i.stateId === o.value;
      case 'priority':
        return String(i.priority) === o.value;
      case 'assignee':
        return (i.assigneeId ?? 'none') === o.value;
      case 'labels':
        return i.labelIds.includes(o.value);
      case 'project':
        return (i.projectId ?? 'none') === o.value;
      case 'cycle':
        return (i.cycleId ?? 'none') === o.value;
      case 'estimate':
        return String(i.estimate ?? 'none') === o.value;
      case 'team':
        return i.teamId === o.value;
      default:
        return false;
    }
  };

  const label =
    targetIssues.length === 1 ? targetIssues[0]!.identifier : `${targets.length} issues`;

  return (
    <Modal open onClose={close} width={640} label="Command menu">
      <Command
        loop
        className="flex min-h-0 flex-col"
        onKeyDown={(e) => {
          if (e.key === 'Backspace' && !query && page !== 'root') {
            e.preventDefault();
            ui.set({ palette: 'root' });
          }
          // Digits pick the nth option on property pages, like the hints show.
          if (page !== 'root' && !query && /^[1-9]$/.test(e.key)) {
            const items = e.currentTarget.querySelectorAll<HTMLElement>('[cmdk-item]');
            const item = items[Number(e.key) - 1];
            if (item) {
              e.preventDefault();
              item.click();
            }
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-border-soft px-4">
          {page !== 'root' && (
            <span className="flex-none font-mono text-[11px] tracking-[0.1em] text-primary uppercase">
              {label} <span className="text-muted">//</span> {PAGE_TITLES[page]}
            </span>
          )}
          {page === 'root' && targets.length > 0 && (
            <span className="flex-none bg-raised px-1.5 py-0.5 font-mono text-[11px] text-primary">
              {label}
            </span>
          )}
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={page === 'root' ? 'Type a command or search issues…' : 'Filter…'}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-index"
          />
        </div>
        <Command.List className="max-h-[56vh] overflow-y-auto py-1">
          <Command.Empty>// no results</Command.Empty>

          {page !== 'root' && (
            <Command.Group>
              {subOptions().map((o) => (
                <Command.Item
                  key={o.value}
                  value={`${o.label} ${o.keywords ?? ''} ${o.value}`}
                  onSelect={() => {
                    if (page === 'labels') {
                      const has =
                        targetIssues.length > 0 &&
                        targetIssues.every((i) => i.labelIds.includes(o.value));
                      apply(has ? { removeLabelIds: [o.value] } : { addLabelIds: [o.value] }, true);
                    } else if (page === 'team') {
                      for (const id of targets)
                        api.patch(`/w/${ws.slug}/issues/${id}`, { teamId: o.value });
                      setTimeout(() => qc.invalidateQueries({ queryKey: ['ws', ws.slug] }), 300);
                      close();
                    } else apply(patchFor(page, o.value));
                  }}
                >
                  {o.icon}
                  <span className="flex-1 truncate">{o.label}</span>
                  {current(o) && (
                    <span className="font-mono text-[11px] text-primary">current</span>
                  )}
                  {o.hint && <span className="font-mono text-[11px] text-index">{o.hint}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {page === 'root' && (
            <>
              {targets.length > 0 && (
                <Command.Group heading={label}>
                  {(Object.keys(PAGE_TITLES) as Exclude<PalettePage, 'root'>[]).map((p) => (
                    <Command.Item
                      key={p}
                      onSelect={() => ui.set({ palette: p })}
                      value={`${PAGE_TITLES[p]} issue`}
                    >
                      <ArrowRight size={15} />
                      {PAGE_TITLES[p]}…
                    </Command.Item>
                  ))}
                  <Command.Item
                    onSelect={() => apply({ assigneeId: ws.me.id })}
                    value="assign to me"
                  >
                    <UserCheck size={15} /> Assign to me
                  </Command.Item>
                  {targetIssues.length === 1 && (
                    <>
                      <Command.Item
                        value="copy issue id identifier"
                        onSelect={() => {
                          navigator.clipboard?.writeText(targetIssues[0]!.identifier);
                          toast.success('Copied identifier');
                          close();
                        }}
                      >
                        <Copy size={15} /> Copy ID
                      </Command.Item>
                      <Command.Item
                        value="copy issue link url"
                        onSelect={() => {
                          navigator.clipboard?.writeText(
                            `${location.origin}/${ws.slug}/issue/${targetIssues[0]!.identifier}`,
                          );
                          toast.success('Copied link');
                          close();
                        }}
                      >
                        <Copy size={15} /> Copy link
                      </Command.Item>
                    </>
                  )}
                  <Command.Item
                    value="delete trash issue"
                    onSelect={() => {
                      trash.mutate(targets);
                      toast(`Moved ${label} to trash`);
                      close();
                    }}
                  >
                    <Trash2 size={15} /> Move to trash
                  </Command.Item>
                </Command.Group>
              )}

              {search.data && search.data.issues.length > 0 && (
                <Command.Group heading="Issues">
                  {search.data.issues.slice(0, 8).map((i) => {
                    const s = ws.stateById.get(i.stateId);
                    return (
                      <Command.Item
                        key={i.id}
                        value={`${i.identifier} ${i.title} ${query}`}
                        onSelect={() => go(`/${ws.slug}/issue/${i.identifier}`)}
                      >
                        {s && <StatusIcon type={s.type} color={s.color} />}
                        <span className="w-16 flex-none font-mono text-[11px] text-index">
                          {i.identifier}
                        </span>
                        <span className="truncate">{i.title}</span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}

              <Command.Group heading="Create">
                <Command.Item
                  value="create new issue"
                  onSelect={() => ui.openCreateIssue({ teamId: ws.myTeams[0]?.id })}
                >
                  <Plus size={15} /> New issue
                  <kbd className="kbd ml-auto">C</kbd>
                </Command.Item>
                <Command.Item
                  value="create new project"
                  onSelect={() => go(`/${ws.slug}/projects?new=1`)}
                >
                  <Hexagon size={15} /> New project
                </Command.Item>
              </Command.Group>

              <Command.Group heading="Navigate">
                <Command.Item
                  value="go inbox notifications"
                  onSelect={() => go(`/${ws.slug}/inbox`)}
                >
                  <Inbox size={15} /> Inbox
                </Command.Item>
                <Command.Item
                  value="go my issues assigned"
                  onSelect={() => go(`/${ws.slug}/my-issues/assigned`)}
                >
                  <Target size={15} /> My issues
                </Command.Item>
                {ws.teams.map((t) => (
                  <Command.Item
                    key={t.id}
                    value={`go team ${t.name} ${t.key} issues`}
                    onSelect={() => go(`/${ws.slug}/team/${t.key}/all`)}
                  >
                    <TeamIcon color={t.color} label={t.key} size={15} /> {t.name} issues
                  </Command.Item>
                ))}
                {ws.teams
                  .filter((t) => t.cyclesEnabled)
                  .map((t) => (
                    <Command.Item
                      key={`c${t.id}`}
                      value={`go team ${t.name} ${t.key} cycles`}
                      onSelect={() => go(`/${ws.slug}/team/${t.key}/cycles`)}
                    >
                      <TeamIcon color={t.color} label={t.key} size={15} /> {t.name} cycles
                    </Command.Item>
                  ))}
                <Command.Item value="go projects" onSelect={() => go(`/${ws.slug}/projects`)}>
                  <Hexagon size={15} /> Projects
                </Command.Item>
                {ws.projects.map((p) => (
                  <Command.Item
                    key={p.id}
                    value={`go project ${p.name}`}
                    onSelect={() => go(`/${ws.slug}/project/${p.id}`)}
                  >
                    <Hexagon size={15} style={{ color: p.color }} /> {p.name}
                  </Command.Item>
                ))}
                <Command.Item value="go views" onSelect={() => go(`/${ws.slug}/views`)}>
                  <Layers size={15} /> Views
                </Command.Item>
                {ws.views.map((v) => (
                  <Command.Item
                    key={v.id}
                    value={`go view ${v.name}`}
                    onSelect={() => go(`/${ws.slug}/view/${v.id}`)}
                  >
                    <Eye size={15} /> {v.name}
                  </Command.Item>
                ))}
                <Command.Item value="search" onSelect={() => go(`/${ws.slug}/search`)}>
                  <Search size={15} /> Search
                </Command.Item>
                <Command.Item value="trash deleted" onSelect={() => go(`/${ws.slug}/trash`)}>
                  <Trash2 size={15} /> Trash
                </Command.Item>
                <Command.Item
                  value="settings preferences account"
                  onSelect={() => go(`/${ws.slug}/settings/account`)}
                >
                  <Settings size={15} /> Settings
                </Command.Item>
              </Command.Group>

              {ws.me.workspaces.length > 1 && (
                <Command.Group heading="Workspaces">
                  {ws.me.workspaces
                    .filter((w) => w.slug !== ws.slug)
                    .map((w) => (
                      <Command.Item
                        key={w.id}
                        value={`switch workspace ${w.name}`}
                        onSelect={() => go(`/${w.slug}`)}
                      >
                        <ArrowRight size={15} /> Switch to {w.name}
                      </Command.Item>
                    ))}
                </Command.Group>
              )}

              <Command.Group heading="Help">
                <Command.Item
                  value="keyboard shortcuts help"
                  onSelect={() => ui.set({ palette: null, shortcuts: true })}
                >
                  <Keyboard size={15} /> Keyboard shortcuts
                  <kbd className="kbd ml-auto">?</kbd>
                </Command.Item>
                <Command.Item
                  value="log out sign out"
                  onSelect={async () => {
                    await api.post('/auth/logout');
                    qc.clear();
                    location.href = '/login';
                  }}
                >
                  <LogOut size={15} /> Log out
                </Command.Item>
              </Command.Group>
            </>
          )}
        </Command.List>
      </Command>
    </Modal>
  );
}
