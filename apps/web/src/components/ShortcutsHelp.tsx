import { t } from '../i18n/index.ts';
import { modKey } from '../lib/hotkeys.ts';
import { ui, useUi } from '../lib/store.ts';
import { Modal } from './ui/Modal.tsx';

/** The shortcut list, in the current language. Key names stay as printed on the keyboard. */
export const shortcuts = (): { section: string; items: [string, string][] }[] => [
  {
    section: t('shell.shortcuts.sections.general'),
    items: [
      [`${modKey} K`, t('shell.shortcuts.commandMenu')],
      ['C', t('shell.shortcuts.createIssue')],
      ['/', t('common.search')],
      ['?', t('shell.shortcuts.title')],
      ['Esc', t('shell.shortcuts.closeOrClear')],
    ],
  },
  {
    section: t('shell.shortcuts.sections.navigation'),
    items: [
      ['G then I', t('shell.nav.inbox')],
      ['G then M', t('shell.nav.myIssues')],
      ['G then T', t('shell.shortcuts.teamIssues')],
      ['G then P', t('common.projects')],
      ['G then V', t('shell.nav.views')],
      ['G then S', t('common.settings')],
    ],
  },
  {
    section: t('shell.shortcuts.sections.issueLists'),
    items: [
      ['J / K', t('shell.shortcuts.moveFocus')],
      ['Enter', t('shell.shortcuts.openFocused')],
      ['X', t('shell.shortcuts.select')],
      [`${modKey} A`, t('shell.shortcuts.selectAll')],
      ['V', t('shell.shortcuts.toggleLayout')],
    ],
  },
  {
    section: t('shell.shortcuts.sections.issueActions'),
    items: [
      ['S', t('shell.palette.pages.status')],
      ['P', t('shell.palette.pages.priority')],
      ['A', t('shell.shortcuts.assign')],
      ['I', t('shell.palette.assignToMe')],
      ['L', t('common.labels')],
      ['Shift P', t('common.project')],
      ['Shift C', t('common.cycle')],
      ['E', t('common.estimate')],
      [`${modKey} ⌫`, t('shell.palette.moveToTrash')],
      [`${modKey} Shift .`, t('shell.shortcuts.copyBranch')],
      [`${modKey} Enter`, t('shell.shortcuts.submit')],
      [`${modKey} B / ${modKey} I`, t('shell.shortcuts.boldItalic')],
    ],
  },
  {
    section: t('shell.nav.inbox'),
    items: [
      ['J / K', t('shell.shortcuts.nextPrevNotification')],
      ['U', t('shell.shortcuts.toggleRead')],
      ['H', t('shell.shortcuts.snooze')],
      ['⌫', t('shell.shortcuts.deleteNotification')],
      ['1 – 4', t('shell.shortcuts.inboxQuickFilter')],
      ['5', t('shell.shortcuts.inboxUnreadOnly')],
      ['Shift F', t('shell.shortcuts.inboxFilters')],
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
      label={t('shell.shortcuts.title')}
    >
      <div className="overflow-y-auto p-6">
        <div className="section-label mb-5">{t('shell.shortcuts.title')}</div>
        <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
          {shortcuts().map((s) => (
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
                    {/* Keys repeat ("Ctrl B / Ctrl I"), so they're keyed by position. */}
                    {k.split(' ').map((p, i) =>
                      p === 'then' ? (
                        <span key={i} className="text-[11px] text-index">
                          {t('shell.shortcuts.thenKey')}
                        </span>
                      ) : (
                        <kbd key={i} className="kbd">
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
