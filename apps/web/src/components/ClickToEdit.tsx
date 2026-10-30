import { type ReactNode, useEffect, useRef } from 'react';
import { useHotkey } from '../lib/hotkeys.ts';

/**
 * Rendered text that turns into `editor` when clicked, focused + Enter/Space, or `D` pressed.
 * Not a real `<button>`: the rendered Markdown holds links and task-list checkboxes, which
 * keep working and never start editing. Focus comes back here when editing ends, so keyboard
 * users don't land at the top of the page.
 */
export function ClickToEdit({
  editing,
  onEdit,
  editor,
  disabled,
  className,
  children,
}: {
  editing: boolean;
  onEdit: () => void;
  editor: ReactNode;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(editing);
  useHotkey('d', onEdit, { enabled: !disabled && !editing });
  useEffect(() => {
    if (wasEditing.current && !editing) ref.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  if (editing) return editor;
  if (disabled) return <div className={className}>{children}</div>;
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      className={`${className ?? ''} cursor-text`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,input')) return;
        onEdit();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        onEdit();
      }}
    >
      {children}
    </div>
  );
}
