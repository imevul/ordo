import type { Favorite } from '@ordo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronRight,
  CircleDot,
  Eye,
  Hexagon,
  Inbox,
  Layers,
  Lock,
  LogOut,
  Plus,
  RefreshCcw,
  Search,
  Settings,
  Shield,
  SquarePen,
  Star,
  Target,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client.ts';
import type { RealtimeStatus } from '../api/realtime.ts';
import { readPref, ui, writePref } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { OrdoMark, ProjectIcon, TeamIcon } from './icons.tsx';
import { Popover } from './ui/Popover.tsx';

function FavoriteLink({ fav }: { fav: Favorite }) {
  const ws = useWorkspace();
  const p = { slug: ws.slug };
  switch (fav.kind) {
    case 'project': {
      const project = ws.projectById.get(fav.targetId);
      if (!project) return null;
      return (
        <Link
          to="/$slug/project/$projectId"
          params={{ ...p, projectId: project.id }}
          className="nav-item"
        >
          <ProjectIcon color={project.color} />
          <span className="truncate">{project.name}</span>
        </Link>
      );
    }
    case 'view': {
      const view = ws.viewById.get(fav.targetId);
      if (!view) return null;
      return (
        <Link to="/$slug/view/$viewId" params={{ ...p, viewId: view.id }} className="nav-item">
          <Eye size={15} />
          <span className="truncate">{view.name}</span>
        </Link>
      );
    }
    case 'team': {
      const team = ws.teamById.get(fav.targetId);
      if (!team) return null;
      return (
        <Link
          to="/$slug/team/$key/$tab"
          params={{ ...p, key: team.key, tab: 'all' }}
          className="nav-item"
        >
          <TeamIcon color={team.color} label={team.key} />
          <span className="truncate">{team.name}</span>
        </Link>
      );
    }
    default:
      return null;
  }
}

export function Sidebar({
  status,
  onNavigate,
}: {
  status: RealtimeStatus;
  onNavigate?: () => void;
}) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [closedTeams, setClosedTeams] = useState<string[]>(() =>
    readPref('sidebar:closedTeams', []),
  );
  const toggleTeam = (id: string) => {
    const next = closedTeams.includes(id)
      ? closedTeams.filter((x) => x !== id)
      : [...closedTeams, id];
    setClosedTeams(next);
    writePref('sidebar:closedTeams', next);
  };
  const p = { slug: ws.slug };
  const isAdmin = ws.isAdmin;

  const logout = async () => {
    await api.post('/auth/logout');
    qc.clear();
    location.href = '/login';
  };

  return (
    <nav
      className="flex h-full w-full flex-col bg-surface"
      aria-label="Main"
      onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}
    >
      <div className="flex h-12 flex-none items-center gap-1 px-3">
        <Popover
          width={260}
          trigger={
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 text-left hover:opacity-90"
              aria-label="Workspace menu"
            >
              <OrdoMark />
              {ws.workspace.logoUrl && (
                <img src={ws.workspace.logoUrl} alt="" className="h-4 w-4 flex-none object-cover" />
              )}
              <span className="truncate text-[13px] text-muted">{ws.workspace.name}</span>
            </button>
          }
        >
          {(close) => (
            <div className="py-1" onClick={close}>
              <div className="px-3 pt-2 pb-1 font-mono text-[10.5px] tracking-[0.14em] text-index uppercase">
                {ws.me.email}
              </div>
              {ws.me.workspaces.map((w) => (
                <button
                  type="button"
                  key={w.id}
                  className="menu-item"
                  onClick={() => navigate({ to: '/$slug', params: { slug: w.slug } })}
                >
                  <span
                    className={`h-[7px] w-[7px] ${w.slug === ws.slug ? 'bg-primary shadow-[0_0_10px_#ff1493]' : 'bg-border'}`}
                  />
                  {w.name}
                </button>
              ))}
              <button
                type="button"
                className="menu-item"
                onClick={() => navigate({ to: '/onboarding' })}
              >
                <Plus size={14} /> Create workspace
              </button>
              <div className="my-1 h-px bg-border-soft" />
              <Link
                to="/$slug/settings/$section"
                params={{ ...p, section: 'account' }}
                className="menu-item"
              >
                <Settings size={14} /> Settings
              </Link>
              {isAdmin && (
                <Link
                  to="/$slug/settings/$section"
                  params={{ ...p, section: 'members' }}
                  className="menu-item"
                >
                  <UserPlus size={14} /> Invite members
                </Link>
              )}
              {ws.me.isInstanceAdmin && (
                <Link to="/admin/$section" params={{ section: 'overview' }} className="menu-item">
                  <Shield size={14} /> Instance admin
                </Link>
              )}
              <button type="button" className="menu-item" onClick={logout}>
                <LogOut size={14} /> Log out
              </button>
            </div>
          )}
        </Popover>
        <Link
          to="/$slug/search"
          params={p}
          className="flex h-7 w-7 items-center justify-center text-muted hover:text-text"
          aria-label="Search"
        >
          <Search size={15} />
        </Link>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center bg-raised text-muted hover:text-primary"
          onClick={() => ui.openCreateIssue({ teamId: ws.myTeams[0]?.id })}
          aria-label="New issue"
          title="New issue (C)"
        >
          <SquarePen size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <div className="flex flex-col gap-px">
          <Link to="/$slug/inbox" params={p} className="nav-item">
            <Inbox size={15} />
            Inbox
            {ws.unreadCount > 0 && (
              <span className="ml-auto bg-primary px-1.5 font-mono text-[10.5px] font-semibold text-bg">
                {ws.unreadCount}
              </span>
            )}
          </Link>
          <Link
            to="/$slug/my-issues/$tab"
            params={{ ...p, tab: 'assigned' }}
            className="nav-item"
            activeOptions={{ includeSearch: false }}
          >
            <Target size={15} />
            My issues
          </Link>
        </div>

        <div className="mt-5 mb-1 px-2 font-mono text-[10.5px] font-semibold tracking-[0.2em] text-index uppercase">
          Workspace
        </div>
        <div className="flex flex-col gap-px">
          <Link to="/$slug/projects" params={p} className="nav-item">
            <Hexagon size={15} />
            Projects
          </Link>
          <Link to="/$slug/views" params={p} className="nav-item">
            <Layers size={15} />
            Views
          </Link>
          <Link to="/$slug/trash" params={p} className="nav-item">
            <Trash2 size={15} />
            Trash
          </Link>
        </div>

        {ws.favorites.length > 0 && (
          <>
            <div className="mt-5 mb-1 flex items-center gap-1.5 px-2 font-mono text-[10.5px] font-semibold tracking-[0.2em] text-index uppercase">
              <Star size={11} /> Favorites
            </div>
            <div className="flex flex-col gap-px">
              {ws.favorites.map((f) => (
                <FavoriteLink key={f.id} fav={f} />
              ))}
            </div>
          </>
        )}

        <div className="mt-5 mb-1 px-2 font-mono text-[10.5px] font-semibold tracking-[0.2em] text-index uppercase">
          Your teams
        </div>
        {ws.myTeams.map((t) => {
          const open = !closedTeams.includes(t.id);
          return (
            <div key={t.id} className="mb-1">
              <button
                type="button"
                className="nav-item w-full"
                onClick={() => toggleTeam(t.id)}
                aria-expanded={open}
              >
                <TeamIcon color={t.color} label={t.key} />
                <span className="truncate">{t.name}</span>
                {t.private && (
                  <Lock size={11} className="flex-none text-index" aria-label="Private team" />
                )}
                <ChevronRight
                  size={12}
                  className={`ml-auto text-index transition-transform ${open ? 'rotate-90' : ''}`}
                />
              </button>
              {open && (
                <div className="ml-3 flex flex-col gap-px border-l border-border-soft pl-2">
                  {t.triageEnabled && (
                    <Link
                      to="/$slug/team/$key/$tab"
                      params={{ ...p, key: t.key, tab: 'triage' }}
                      className="nav-item"
                    >
                      <CircleDot size={14} /> Triage
                    </Link>
                  )}
                  <Link
                    to="/$slug/team/$key/$tab"
                    params={{ ...p, key: t.key, tab: 'all' }}
                    className="nav-item"
                  >
                    <Layers size={14} /> Issues
                  </Link>
                  {t.cyclesEnabled && (
                    <Link
                      to="/$slug/team/$key/cycles"
                      params={{ ...p, key: t.key }}
                      className="nav-item"
                    >
                      <RefreshCcw size={14} /> Cycles
                    </Link>
                  )}
                  <Link
                    to="/$slug/projects"
                    params={p}
                    search={{ team: t.key }}
                    className="nav-item"
                    activeOptions={{ includeSearch: true }}
                  >
                    <Hexagon size={14} /> Projects
                  </Link>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex h-9 flex-none items-center gap-2 border-t border-border-soft px-3 font-mono text-[10.5px] tracking-[0.12em] text-index uppercase">
        <span
          className={`h-[7px] w-[7px] ${status === 'live' ? 'bg-success shadow-[0_0_10px_#22c55e]' : status === 'connecting' ? 'bg-warning' : 'bg-error'}`}
          aria-hidden
        />
        {status === 'live' ? 'live' : status === 'connecting' ? 'connecting' : 'offline'}
        <button
          type="button"
          className="ml-auto hover:text-text"
          onClick={() => ui.set({ shortcuts: true })}
          title="Keyboard shortcuts"
        >
          ? keys
        </button>
      </div>
    </nav>
  );
}
