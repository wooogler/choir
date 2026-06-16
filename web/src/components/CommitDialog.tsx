import { useEffect, useRef, useState } from 'react';

type CommitDialogProps = {
  defaultMessage: string;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (commitMessage: string) => void;
};

export function CommitDialog({ defaultMessage, submitting, onCancel, onSubmit }: CommitDialogProps) {
  const [message, setMessage] = useState(defaultMessage);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
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

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <div className="commit-dialog-backdrop" role="dialog" aria-modal="true" aria-label="Commit changes">
      <form className="commit-dialog" onSubmit={handleSubmit}>
        <h2 className="commit-dialog-title">Commit changes</h2>
        <p className="commit-dialog-subtitle">
          A new commit will be pushed to your GitHub repository. Q&A retrieval and the QMD index refresh
          automatically.
        </p>
        <label className="commit-dialog-label" htmlFor="commit-message">
          Commit message
        </label>
        <textarea
          ref={inputRef}
          id="commit-message"
          className="commit-dialog-input"
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={submitting}
          required
        />
        <div className="commit-dialog-actions">
          <button
            type="button"
            className="doc-button doc-button-ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button type="submit" className="doc-button doc-button-primary" disabled={submitting || !message.trim()}>
            {submitting ? 'Committing…' : 'Commit & push'}
          </button>
        </div>
      </form>
    </div>
  );
}
