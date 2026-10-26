import { modKey } from '../lib/hotkeys.ts';
import { ui, useUi } from '../lib/store.ts';
import { Modal } from './ui/Modal.tsx';

export const SHORTCUTS: { section: string; items: [string, string][] }[] = [
  {
    section: 'General',
    items: [
      [`${modKey} K`, 'Command menu'],
      ['C', 'Create issue'],
      ['/', 'Search'],
      ['?', 'Keyboard shortcuts'],
      ['Esc', 'Close / clear selection'],
    ],
  },
  {
    section: 'Navigation',
    items: [
      ['G then I', 'Inbox'],
      ['G then M', 'My issues'],
      ['G then T', 'Team issues'],
      ['G then P', 'Projects'],
      ['G then V', 'Views'],
      ['G then S', 'Settings'],
    ],
  },
  {
    section: 'Issue lists',
    items: [
      ['J / K', 'Move focus down / up'],
      ['Enter', 'Open focused issue'],
      ['X', 'Select (Shift for range)'],
      [`${modKey} A`, 'Select all'],
      ['V', 'Toggle list / board'],
    ],
  },
  {
    section: 'Issue actions',
    items: [
      ['S', 'Change status'],
      ['P', 'Set priority'],
      ['A', 'Assign'],
      ['I', 'Assign to me'],
      ['L', 'Labels'],
      ['Shift P', 'Project'],
      ['Shift C', 'Cycle'],
      ['E', 'Estimate'],
      [`${modKey} ⌫`, 'Move to trash'],
      [`${modKey} Shift .`, 'Copy git branch name (open issue)'],
      [`${modKey} Enter`, 'Submit (forms, comments)'],
      [`${modKey} B / ${modKey} I`, 'Bold / italic (in text)'],
    ],
  },
];

export function ShortcutsHelp() {
  const open = useUi((s) => s.shortcuts);
  return (
    <Modal
      open={open}
      onClose={() => ui.set({ shortcuts: false })}
      width={720}
      label="Keyboard shortcuts"
    >
      <div className="overflow-y-auto p-6">
        <div className="section-label mb-5">Keyboard shortcuts</div>
        <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
          {SHORTCUTS.map((s) => (
            <div key={s.section}>
              <div className="mb-2 font-mono text-[11px] tracking-[0.14em] text-index uppercase">
                {s.section}
              </div>
              {s.items.map(([k, label]) => (
                <div
                  key={label}
                  className="flex items-center justify-between py-1 text-[13px] text-muted"
                >
                  {label}
                  <span className="flex gap-1">
                    {k.split(' ').map((p) =>
                      p === 'then' ? (
                        <span key={p} className="text-[11px] text-index">
                          then
                        </span>
                      ) : (
                        <kbd key={p} className="kbd">
                          {p}
                        </kbd>
                      ),
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
