import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  type Placement,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { cloneElement, isValidElement, type ReactNode, useState } from 'react';
import { useHotkeyScope } from '../../lib/hotkeys.ts';

interface Props {
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  placement?: Placement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  width?: number;
  className?: string;
}

/** A click-to-open floating panel, rendered in a portal with a chamfered frame. */
export function Popover({
  trigger,
  children,
  placement = 'bottom-start',
  open: controlled,
  onOpenChange,
  width,
  className = '',
}: Props) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = (v: boolean) => {
    setUncontrolled(v);
    onOpenChange?.(v);
  };
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(160, availableHeight)}px`;
        },
      }),
    ],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context),
    useDismiss(context),
    useRole(context),
  ]);
  useHotkeyScope('popover', open);

  const triggerEl = isValidElement(trigger) ? (
    cloneElement(trigger as React.ReactElement<Record<string, unknown>>, {
      ref: refs.setReference,
      ...getReferenceProps({
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
      }),
    })
  ) : (
    <button type="button" ref={refs.setReference} {...getReferenceProps()}>
      {trigger}
    </button>
  );

  return (
    <>
      {triggerEl}
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
            <div
              ref={refs.setFloating}
              style={{ ...floatingStyles, width, zIndex: 60 }}
              {...getFloatingProps({ onClick: (e: React.MouseEvent) => e.stopPropagation() })}
              className={`panel panel-sm panel-raised animate-pop flex flex-col overflow-hidden ${className}`}
            >
              {typeof children === 'function' ? children(() => setOpen(false)) : children}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
