import { useEffect, useRef, useState } from 'react';

/**
 * Confirmation for deleting a document.
 *
 * A window.confirm — the house pattern for the other destructive actions — is
 * one Enter keystroke away from a document nobody meant to remove, so this asks
 * for the path to be typed instead. The point is not that typing proves
 * anything; it is that it cannot happen by reflex.
 */

type DeleteDocumentDialogProps = {
  filePath: string;
  /** The branch the deletion will be pushed to, named so it is not a surprise. */
  branch?: string;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteDocumentDialog({ filePath, branch, submitting, onCancel, onConfirm }: DeleteDocumentDialogProps) {
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel, submitting]);

  const matches = typed === filePath;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!matches || submitting) return;
    onConfirm();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: matches CommitDialog — a native <dialog> would need showModal()
    <div className="commit-dialog-backdrop" role="dialog" aria-modal="true" aria-label="Delete document">
      <form className="commit-dialog" onSubmit={handleSubmit}>
        <h2 className="commit-dialog-title">Delete this document</h2>
        <p className="commit-dialog-subtitle">
          <code>{filePath}</code> will be removed from the repository
          {branch ? (
            <>
              {' '}
              on <code>{branch}</code>
            </>
          ) : null}{' '}
          and will stop answering questions. If it has a Google Docs replica, that is unlinked and any pending review is
          dropped. Nothing is lost from git — the commit history keeps every version, so it can be restored from there.
        </p>
        <label className="commit-dialog-label" htmlFor="delete-confirm-path">
          Type <code>{filePath}</code> to confirm
        </label>
        <input
          ref={inputRef}
          id="delete-confirm-path"
          className="commit-dialog-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          disabled={submitting}
        />
        <div className="commit-dialog-actions">
          <button type="button" className="doc-button doc-button-ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="doc-button doc-button-danger" disabled={submitting || !matches}>
            {submitting ? 'Deleting…' : 'Delete document'}
          </button>
        </div>
      </form>
    </div>
  );
}
