import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './Button';

/**
 * A modal dialog. React runs a child's `autoFocus` when it mounts, while the
 * dialog is still closed (so the focus call does nothing), and writes no
 * `autofocus` attribute, so showModal() alone focuses the first control: the
 * Esc button. A control marked `data-autofocus` takes the focus once the
 * dialog is open instead.
 */
export function Dialog({ open, onClose, title, children, footer, width }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && el.open) {
      el.close();
      // Opened from the command palette, the dialog's opener no longer exists: give the keyboard back to the list.
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) document.querySelector<HTMLElement>('.split-left [role="grid"], [role="grid"]')?.focus();
      });
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      style={width ? { width } : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-head">
        <h3>{title}</h3>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          Esc
        </Button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer ? <div className="dialog-foot">{footer}</div> : null}
    </dialog>
  );
}

/**
 * A yes/no confirmation built on Dialog. A `danger` confirmation (delete,
 * remove, retire) opens with Cancel focused, so Enter or Space pressed right
 * after it opens backs out; the danger button takes a deliberate Tab or click.
 */
export function Confirm({ open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', danger }: { open: boolean; onClose: () => void; onConfirm: () => void; title: ReactNode; body?: ReactNode; confirmLabel?: string; danger?: boolean }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose} autoFocus={Boolean(danger)} data-autofocus={danger ? '' : undefined}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            autoFocus={!danger}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body ?? null}
    </Dialog>
  );
}
