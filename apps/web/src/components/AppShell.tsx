import { Outlet, useNavigate } from '@tanstack/react-router';
import { Menu } from 'lucide-react';
import { useState } from 'react';
import { useRealtime } from '../api/realtime.ts';
import { useHotkey } from '../lib/hotkeys.ts';
import { ui } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { CreateIssueModal } from './CreateIssueModal.tsx';
import { ShortcutsHelp } from './ShortcutsHelp.tsx';
import { Sidebar } from './Sidebar.tsx';

export function AppShell() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const status = useRealtime(ws.slug);
  const [mobileNav, setMobileNav] = useState(false);
  const p = { slug: ws.slug };

  useHotkey('mod+k', () => ui.openPalette('root'), { allowInInput: true });
  useHotkey('c', () => ui.openCreateIssue({ teamId: ws.myTeams[0]?.id }));
  useHotkey('?', () => ui.set({ shortcuts: true }));
  useHotkey('/', () => navigate({ to: '/$slug/search', params: p }));
  useHotkey('g i', () => navigate({ to: '/$slug/inbox', params: p }));
  useHotkey('g m', () =>
    navigate({ to: '/$slug/my-issues/$tab', params: { ...p, tab: 'assigned' } }),
  );
  useHotkey('g p', () => navigate({ to: '/$slug/projects', params: p }));
  useHotkey('g v', () => navigate({ to: '/$slug/views', params: p }));
  useHotkey('g s', () =>
    navigate({ to: '/$slug/settings/$section', params: { ...p, section: 'account' } }),
  );
  useHotkey('g t', () => {
    const team = ws.myTeams[0];
    if (team)
      navigate({ to: '/$slug/team/$key/$tab', params: { ...p, key: team.key, tab: 'all' } });
  });

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 flex-none border-r border-border-soft md:block">
        <Sidebar status={status} />
      </aside>
      {mobileNav && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setMobileNav(false)}>
          <div className="absolute inset-0 bg-bg/70" />
          <aside
            className="absolute inset-y-0 left-0 w-72 border-r border-border"
            onClick={(e) => e.stopPropagation()}
          >
            <Sidebar status={status} onNavigate={() => setMobileNav(false)} />
          </aside>
        </div>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <button
          type="button"
          className="fixed bottom-4 left-4 z-30 flex h-10 w-10 items-center justify-center bg-raised text-text shadow-[inset_0_0_0_1px_var(--color-border)] md:hidden"
          onClick={() => setMobileNav(true)}
          aria-label="Open navigation"
        >
          <Menu size={18} />
        </button>
        <Outlet />
      </main>
      <CreateIssueModal />
      <CommandPalette />
      <ShortcutsHelp />
    </div>
  );
}
