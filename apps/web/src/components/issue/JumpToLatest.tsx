import { ArrowDown } from 'lucide-react';
import { type RefObject, useEffect, useState } from 'react';
import { t } from '../../i18n/index.ts';
import { useHotkey } from '../../lib/hotkeys.ts';

/** How far from the bottom (px) the reader must be before the button shows up. */
const THRESHOLD = 240;

/**
 * A floating "jump to latest" button over a scroll container, shown while the bottom (the newest
 * activity and the comment box) is out of view. The parent must be positioned.
 */
export function JumpToLatest({
  scroller,
  hotkey = true,
}: {
  scroller: RefObject<HTMLElement | null>;
  hotkey?: boolean;
}) {
  const [away, setAway] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => setAway(el.scrollHeight - el.scrollTop - el.clientHeight > THRESHOLD);
    check();
    el.addEventListener('scroll', check, { passive: true });
    // The content grows after the first paint as activity, attachments and runs load.
    const resize = new ResizeObserver(check);
    resize.observe(el);
    for (const child of el.children) resize.observe(child);
    return () => {
      el.removeEventListener('scroll', check);
      resize.disconnect();
    };
  }, [scroller]);

  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  };
  useHotkey('shift+g', jump, { enabled: hotkey });

  if (!away) return null;
  return (
    <button
      type="button"
      onClick={jump}
      title={`${t('issue.detail.jumpToLatest')} (Shift G)`}
      className="btn btn-ghost btn-sm animate-pop absolute right-4 bottom-4 z-10 bg-raised"
    >
      <ArrowDown size={13} aria-hidden />
      {t('issue.detail.jumpToLatest')}
    </button>
  );
}
