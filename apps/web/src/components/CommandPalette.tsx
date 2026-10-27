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
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  Target,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api/client.ts';
import { useBatchUpdateIssues, useSearch, useTrashIssues } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { useHotkeyScope } from '../lib/hotkeys.ts';
import { signOut } from '../lib/signOut.ts';
import { type PalettePage, ui, useUi } from '../lib/store.ts';
import { setThemePref, THEME_PREFS, useTheme } from '../lib/theme.ts';
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

type SubPage = Exclude<PalettePage, 'root'>;

/** English search words for each page, so commands can be found in English whatever the language. */
const PAGE_KEYWORDS: Record<SubPage, string> = {
  status: 'change status',
  priority: 'set priority',
  assignee: 'assign to',
  labels: 'labels',
  project: 'set project',
  cycle: 'set cycle',
  estimate: 'set estimate',
  team: 'move to team',
};
const SUB_PAGES = Object.keys(PAGE_KEYWORDS) as SubPage[];

const pageTitle = (page: SubPage) =>
  page === 'labels' ? t('common.labels') : t(`shell.palette.pages.${page}`);

export function CommandPalette() {
  const page = useUi((s) => s.palette);
  const targets = useUi((s) => s.paletteTargets);
  const ws = useWorkspace();
  const qc = useQueryClient();
  const theme = useTheme();
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
    targetIssues.length === 1
      ? targetIssues[0]!.identifier
      : t('common.issueCount', { count: targets.length });

  return (
    <Modal open onClose={close} width={640} label={t('shell.palette.label')}>
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
              {label} <span className="text-muted">//</span> {pageTitle(page)}
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
            placeholder={page === 'root' ? t('shell.palette.placeholder') : t('shell.filter')}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-index"
          />
        </div>
        <Command.List className="max-h-[56vh] overflow-y-auto py-1">
          <Command.Empty>// {t('shell.palette.noResults')}</Command.Empty>

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
                    <span className="font-mono text-[11px] text-primary">
                      {t('shell.palette.current')}
                    </span>
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
                  {SUB_PAGES.map((p) => (
                    <Command.Item
                      key={p}
                      onSelect={() => ui.set({ palette: p })}
                      value={`${PAGE_KEYWORDS[p]} issue ${pageTitle(p)}`}
                    >
                      <ArrowRight size={15} />
                      {pageTitle(p)}…
                    </Command.Item>
                  ))}
                  <Command.Item
                    onSelect={() => apply({ assigneeId: ws.me.id })}
                    value={`assign to me ${t('shell.palette.assignToMe')}`}
                  >
                    <UserCheck size={15} /> {t('shell.palette.assignToMe')}
                  </Command.Item>
                  {targetIssues.length === 1 && (
                    <>
                      <Command.Item
                        value={`copy issue id identifier ${t('shell.palette.copyId')}`}
                        onSelect={() => {
                          navigator.clipboard?.writeText(targetIssues[0]!.identifier);
                          toast.success(t('shell.palette.copiedId'));
                          close();
                        }}
                      >
                        <Copy size={15} /> {t('shell.palette.copyId')}
                      </Command.Item>
                      <Command.Item
                        value={`copy issue link url ${t('shell.palette.copyLink')}`}
                        onSelect={() => {
                          navigator.clipboard?.writeText(
                            `${location.origin}/${ws.slug}/issue/${targetIssues[0]!.identifier}`,
                          );
                          toast.success(t('shell.palette.copiedLink'));
                          close();
                        }}
                      >
                        <Copy size={15} /> {t('shell.palette.copyLink')}
                      </Command.Item>
                    </>
                  )}
                  <Command.Item
                    value={`delete trash issue ${t('shell.palette.moveToTrash')}`}
                    onSelect={() => {
                      trash.mutate(targets);
                      toast(
                        targetIssues.length === 1
                          ? t('shell.palette.movedOneToTrash', { id: targetIssues[0]!.identifier })
                          : t('shell.palette.movedToTrash', { count: targets.length }),
                      );
                      close();
                    }}
                  >
                    <Trash2 size={15} /> {t('shell.palette.moveToTrash')}
                  </Command.Item>
                </Command.Group>
              )}

              {search.data && search.data.issues.length > 0 && (
                <Command.Group heading={t('common.issues')}>
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
                        {i.archivedAt && (
                          <span className="ml-auto font-mono text-[10.5px] text-index">
                            {t('shell.palette.archived')}
                          </span>
                        )}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              )}

              <Command.Group heading={t('common.create')}>
                <Command.Item
                  value={`create new issue ${t('shell.palette.newIssue')}`}
                  onSelect={() => ui.openCreateIssue({ teamId: ws.myTeams[0]?.id })}
                >
                  <Plus size={15} /> {t('shell.palette.newIssue')}
                  <kbd className="kbd ml-auto">C</kbd>
                </Command.Item>
                {!ws.isGuest && (
                  <Command.Item
                    value={`create new project ${t('shell.palette.newProject')}`}
                    onSelect={() => go(`/${ws.slug}/projects?new=1`)}
                  >
                    <Hexagon size={15} /> {t('shell.palette.newProject')}
                  </Command.Item>
                )}
              </Command.Group>

              <Command.Group heading={t('shell.palette.groups.navigate')}>
                <Command.Item
                  value={`go inbox notifications ${t('shell.nav.inbox')}`}
                  onSelect={() => go(`/${ws.slug}/inbox`)}
                >
                  <Inbox size={15} /> {t('shell.nav.inbox')}
                </Command.Item>
                <Command.Item
                  value={`go my issues assigned ${t('shell.nav.myIssues')}`}
                  onSelect={() => go(`/${ws.slug}/my-issues/assigned`)}
                >
                  <Target size={15} /> {t('shell.nav.myIssues')}
                </Command.Item>
                {ws.teams.map((team) => {
                  const text = t('shell.palette.teamIssues', { team: team.name });
                  return (
                    <Command.Item
                      key={team.id}
                      value={`go team ${team.name} ${team.key} issues ${text}`}
                      onSelect={() => go(`/${ws.slug}/team/${team.key}/all`)}
                    >
                      <TeamIcon color={team.color} label={team.key} size={15} /> {text}
                    </Command.Item>
                  );
                })}
                {ws.teams
                  .filter((team) => team.cyclesEnabled)
                  .map((team) => {
                    const text = t('shell.palette.teamCycles', { team: team.name });
                    return (
                      <Command.Item
                        key={`c${team.id}`}
                        value={`go team ${team.name} ${team.key} cycles ${text}`}
                        onSelect={() => go(`/${ws.slug}/team/${team.key}/cycles`)}
                      >
                        <TeamIcon color={team.color} label={team.key} size={15} /> {text}
                      </Command.Item>
                    );
                  })}
                <Command.Item
                  value={`go projects ${t('common.projects')}`}
                  onSelect={() => go(`/${ws.slug}/projects`)}
                >
                  <Hexagon size={15} /> {t('common.projects')}
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
                <Command.Item
                  value={`go views ${t('shell.nav.views')}`}
                  onSelect={() => go(`/${ws.slug}/views`)}
                >
                  <Layers size={15} /> {t('shell.nav.views')}
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
                <Command.Item
                  value={`search ${t('common.search')}`}
                  onSelect={() => go(`/${ws.slug}/search`)}
                >
                  <Search size={15} /> {t('common.search')}
                </Command.Item>
                <Command.Item
                  value={`trash deleted ${t('shell.nav.trash')}`}
                  onSelect={() => go(`/${ws.slug}/trash`)}
                >
                  <Trash2 size={15} /> {t('shell.nav.trash')}
                </Command.Item>
                <Command.Item
                  value={`settings preferences account ${t('common.settings')}`}
                  onSelect={() => go(`/${ws.slug}/settings/account`)}
                >
                  <Settings size={15} /> {t('common.settings')}
                </Command.Item>
              </Command.Group>

              {ws.me.workspaces.length > 1 && (
                <Command.Group heading={t('shell.palette.groups.workspaces')}>
                  {ws.me.workspaces
                    .filter((w) => w.slug !== ws.slug)
                    .map((w) => (
                      <Command.Item
                        key={w.id}
                        value={`switch workspace ${w.name} ${t('shell.palette.switchTo', { name: w.name })}`}
                        onSelect={() => go(`/${w.slug}`)}
                      >
                        <ArrowRight size={15} /> {t('shell.palette.switchTo', { name: w.name })}
                      </Command.Item>
                    ))}
                </Command.Group>
              )}

              <Command.Group heading={t('shell.palette.groups.appearance')}>
                {THEME_PREFS.filter((pref) => pref.value !== theme.pref).map((pref) => {
                  const text =
                    pref.value === 'system'
                      ? t('shell.palette.useSystemTheme')
                      : pref.value === 'light'
                        ? t('shell.palette.useLightTheme')
                        : t('shell.palette.useDarkTheme');
                  return (
                    <Command.Item
                      key={pref.value}
                      value={`theme ${pref.value} ${pref.value === 'system' ? 'automatic' : `${pref.value} mode`} ${text}`}
                      onSelect={() => {
                        setThemePref(pref.value);
                        ui.set({ palette: null });
                      }}
                    >
                      {pref.value === 'light' ? (
                        <Sun size={15} />
                      ) : pref.value === 'dark' ? (
                        <Moon size={15} />
                      ) : (
                        <Monitor size={15} />
                      )}
                      {text}
                    </Command.Item>
                  );
                })}
              </Command.Group>

              <Command.Group heading={t('shell.palette.groups.help')}>
                <Command.Item
                  value={`keyboard shortcuts help ${t('shell.shortcuts.title')}`}
                  onSelect={() => ui.set({ palette: null, shortcuts: true })}
                >
                  <Keyboard size={15} /> {t('shell.shortcuts.title')}
                  <kbd className="kbd ml-auto">?</kbd>
                </Command.Item>
                <Command.Item
                  value={`log out sign out ${t('common.logOut')}`}
                  onSelect={() => signOut(qc)}
                >
                  <LogOut size={15} /> {t('common.logOut')}
                </Command.Item>
              </Command.Group>
            </>
          )}
        </Command.List>
      </Command>
    </Modal>
  );
}
