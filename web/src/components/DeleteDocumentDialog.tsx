import { useEffect, useRef, useState } from 'react';
import { fillNodes, useT } from '../i18n';

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
  const t = useT();
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
    <div className="commit-dialog-backdrop" role="dialog" aria-modal="true" aria-label={t('delete.aria.dialog')}>
      <form className="commit-dialog" onSubmit={handleSubmit}>
        <h2 className="commit-dialog-title">{t('delete.title')}</h2>
        <p className="commit-dialog-subtitle">
          {branch
            ? fillNodes(t('delete.body.onBranch'), { path: <code>{filePath}</code>, branch: <code>{branch}</code> })
            : fillNodes(t('delete.body'), { path: <code>{filePath}</code> })}
        </p>
        <label className="commit-dialog-label" htmlFor="delete-confirm-path">
          {fillNodes(t('delete.label.confirm'), { path: <code>{filePath}</code> })}
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
            {t('common.button.cancel')}
          </button>
          <button type="submit" className="doc-button doc-button-danger" disabled={submitting || !matches}>
            {submitting ? t('delete.button.submitting') : t('delete.button.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
