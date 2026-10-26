import {
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  useFloating,
} from '@floating-ui/react';
import { type ReactNode, useEffect, useState } from 'react';
import { useHotkey, useHotkeyScope } from '../../lib/hotkeys.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  label?: string;
  align?: 'center' | 'top';
}

export function Modal({ open, onClose, children, width = 640, label, align = 'top' }: Props) {
  const { refs, context } = useFloating({ open, onOpenChange: (v) => !v && onClose() });
  useHotkeyScope('modal', open);
  useHotkey('escape', onClose, { scope: 'modal', allowInInput: true, enabled: open });
  if (!open) return null;
  return (
    <FloatingPortal>
      <FloatingOverlay
        lockScroll
        className={`z-50 flex justify-center bg-bg/70 px-4 backdrop-blur-[2px] ${align === 'top' ? 'items-start pt-[12vh]' : 'items-center'}`}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <FloatingFocusManager context={context} initialFocus={-1}>
          <div
            ref={refs.setFloating}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className="panel panel-raised animate-pop flex max-h-[76vh] w-full flex-col"
            style={{ maxWidth: width }}
          >
            {children}
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  );
}

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} width={440} label={title} align="center">
      <div className="p-6">
        <div className="section-label mb-4">{danger ? 'Careful' : 'Confirm'}</div>
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        <div className="mt-2 text-[13.5px] text-muted">{body}</div>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            autoFocus
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

let showConfirm: ((req: ConfirmRequest & { resolve: (ok: boolean) => void }) => void) | null = null;

/**
 * Asks for confirmation in Ordo's own dialog: `if (!(await confirmDialog({ title }))) return;`.
 * Native `confirm()` is off-brand and silently returns false in embedded browsers.
 */
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    if (showConfirm) showConfirm({ ...req, resolve });
    else resolve(false);
  });
}

/** Renders `confirmDialog` requests. Mounted once, at the root. */
export function ConfirmHost() {
  const [req, setReq] = useState<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(
    null,
  );
  useEffect(() => {
    showConfirm = setReq;
    return () => {
      showConfirm = null;
    };
  }, []);
  if (!req) return null;
  const done = (ok: boolean) => {
    req.resolve(ok);
    setReq(null);
  };
  return (
    <ConfirmModal
      open
      title={req.title}
      body={req.body ?? null}
      confirmLabel={req.confirmLabel ?? (req.danger ? 'Delete' : 'Confirm')}
      danger={req.danger}
      onConfirm={() => done(true)}
      onClose={() => done(false)}
    />
  );
}
