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
  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    // Position with top/left: the pop-in animation animates `transform`, which would
    // otherwise override Floating UI's translate() and pin the panel at (0,0) mid-animation.
    transform: false,
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
              // Invisible until Floating UI has measured it; otherwise it flashes at (0,0) for a frame.
              // Opacity (not visibility) so autofocused inputs inside can still take focus.
              style={{
                ...floatingStyles,
                width,
                zIndex: 60,
                opacity: isPositioned ? 1 : 0,
                pointerEvents: isPositioned ? undefined : 'none',
              }}
              {...getFloatingProps({ onClick: (e: React.MouseEvent) => e.stopPropagation() })}
              className={`panel panel-sm panel-raised panel-clip flex flex-col overflow-hidden ${isPositioned ? 'animate-pop' : ''} ${className}`}
            >
              <div className="panel-body flex min-h-0 flex-1 flex-col">
                {typeof children === 'function' ? children(() => setOpen(false)) : children}
              </div>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
