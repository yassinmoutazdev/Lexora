import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * A modal confirmation, built on the native `<dialog>` element.
 *
 * ## Why native, and why that is not a shortcut
 *
 * `showModal()` gives four things a hand-rolled overlay has to reimplement, and usually gets subtly
 * wrong: focus is moved into the dialog and contained there, the rest of the document becomes inert
 * to both pointer and keyboard, `Escape` closes it, and the dialog is exposed to assistive
 * technology as a modal rather than as another `div`. None of that needs a dependency —
 * `ARCHITECTURE` Section 2 pins the dependency set, and a focus-trap library would be a new one for
 * behaviour the platform already ships.
 *
 * ## Why Esc is intercepted rather than allowed through
 *
 * React state is the single source of truth for whether this is open. If the native `cancel` were
 * left alone the element would close itself while `open` stayed `true`, and the next setIsOpen(true)
 * would be a no-op — a dialog that opens once and then never again. So the event is prevented and
 * turned into the same `onCancel` the button calls.
 *
 * `busy` suppresses dismissal: once the action is running, closing the dialog would hide an outcome
 * the reader needs to see, and the work would carry on regardless.
 *
 * ## Why the cancelling action is first
 *
 * `showModal()` focuses the first focusable descendant. The safe choice is the one that keeps things
 * as they are, so it is first in the DOM and receives that focus — a reader who hits Enter out of
 * habit gets the outcome that changes nothing, not the irreversible one.
 *
 * The `id` for `aria-labelledby` is a constant because the application has exactly one dialog. A
 * second one would need it passed in; inventing a uniqueness mechanism for a set of one would be
 * structure that answers nothing.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Go back',
  busy = false,
  busyLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** True while the confirmed action is running: both actions lock and dismissal is suppressed. */
  busy?: boolean;
  /** What the confirm control says while `busy`. Defaults to the confirm label. */
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;

    if (open && !element.open) {
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby="confirm-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="confirm-dialog-title">{title}</h2>

      <div className="confirm-dialog-body">{children}</div>

      <div className="button-row">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button type="button" onClick={onConfirm} disabled={busy} aria-busy={busy}>
          {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
