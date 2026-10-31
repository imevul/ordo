import { Outlet, useNavigate } from '@tanstack/react-router';
import { Menu } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useRealtime } from '../api/realtime.ts';
import { t } from '../i18n/index.ts';
import { useHotkey, useHotkeyScope } from '../lib/hotkeys.ts';
import { ui } from '../lib/store.ts';
import { useWorkspace } from '../lib/workspace.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { CreateIssueModal } from './CreateIssueModal.tsx';
import { ShortcutsHelp } from './ShortcutsHelp.tsx';
import { Sidebar } from './Sidebar.tsx';
import { OfflineBanner } from './SyncStatus.tsx';

export function AppShell() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const status = useRealtime(ws.slug);
  const [mobileNav, setMobileNav] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeMobileNav = useCallback(() => {
    setMobileNav(false);
    // Focus was inside the drawer, which is about to unmount; don't drop it on <body>.
    menuButton.current?.focus();
  }, []);
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
  useHotkey('g d', () => navigate({ to: '/$slug/dashboards', params: p }));
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
        <MobileNav onClose={closeMobileNav}>
          <Sidebar status={status} onNavigate={closeMobileNav} />
        </MobileNav>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <button
          ref={menuButton}
          type="button"
          className="fixed bottom-4 left-4 z-30 flex h-10 w-10 items-center justify-center bg-raised text-text shadow-[inset_0_0_0_1px_var(--color-border)] md:hidden"
          onClick={() => setMobileNav(true)}
          aria-label={t('shell.appShell.openNavigation')}
        >
          <Menu size={18} />
        </button>
        <OfflineBanner />
        <Outlet />
      </main>
      <CreateIssueModal />
      <CommandPalette />
      <ShortcutsHelp />
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The sidebar as a drawer on narrow screens. Like a modal it captures page shortcuts, closes on
 * Escape and keeps Tab inside itself. Dialogs opened from it (new issue, shortcuts) stack on top.
 */
function MobileNav({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useHotkeyScope('drawer');
  useHotkey('escape', onClose, { scope: 'drawer', allowInInput: true });
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    // The drawer is md:hidden; widening the window must not leave its scope swallowing keys.
    const wide = window.matchMedia('(min-width: 768px)');
    const close = () => wide.matches && onClose();
    wide.addEventListener('change', close);
    return () => wide.removeEventListener('change', close);
  }, [onClose]);
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null,
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const inside = ref.current.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="fixed inset-0 z-40 md:hidden" onClick={onClose}>
      <div className="absolute inset-0 bg-bg/70" />
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.appShell.navigation')}
        className="absolute inset-y-0 left-0 w-72 border-r border-border"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trap}
      >
        {children}
      </aside>
    </div>
  );
}
