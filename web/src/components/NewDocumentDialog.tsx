import { useEffect, useMemo, useRef, useState } from 'react';
import { type ServerErrorPayload, describeServerError, fillNodes, useT } from '../i18n';
import { docsPath, folderOf, looksLikeRepoPath } from '../utils/docs';
import { suggestFileNameFromSiblings } from '../utils/file-names';

/**
 * Creating a blank markdown document from the viewer.
 *
 * Two fields rather than one, because the two questions have different answers:
 * the title is what a reader will look for, and the path is where the
 * repository keeps it. The path follows the title until somebody edits it, at
 * which point it stops guessing — a manager who typed a folder meant it.
 *
 * The new file is a sibling of the document currently open. That is the closest
 * thing to an intent this dialog has, and it beats dropping every new document
 * at the repository root — and, since the folder is known, the suggested name
 * can follow whatever convention the folder already keeps
 * (`suggestFileNameFromSiblings`) instead of inventing a plain slug.
 */

type NewDocumentDialogProps = {
  workspaceId: string;
  /** The document open behind the dialog; its folder is where the new one lands. */
  currentPath: string;
  /** Basenames already in that folder; the suggested name follows their lead. */
  siblings: string[];
  /** The branch the commit will be pushed to, named so it is not a surprise. */
  branch?: string;
  onCancel: () => void;
};

export function NewDocumentDialog({ workspaceId, currentPath, siblings, branch, onCancel }: NewDocumentDialogProps) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [filePath, setFilePath] = useState('');
  // Once the path has been typed in, the title stops driving it.
  const [pathEdited, setPathEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
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

  const folder = folderOf(currentPath);
  const suggestion = useMemo(
    () => suggestFileNameFromSiblings(siblings, { title, fallback: 'untitled' }),
    [siblings, title],
  );
  const suggestedPath = folder ? `${folder}/${suggestion.placeholder}` : suggestion.placeholder;

  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (pathEdited) return;
    // The field follows the title, so the suggestion is usually visible as a
    // value rather than as the placeholder. The placeholder is what is left
    // when somebody clears the field, and submitting then uses it.
    const name = suggestFileNameFromSiblings(siblings, { title: value, fallback: 'untitled' }).placeholder;
    setFilePath(value.trim() ? (folder ? `${folder}/${name}` : name) : '');
  };

  const trimmedTitle = title.trim();
  const trimmedPath = filePath.trim();
  const effectivePath = trimmedPath || suggestedPath;
  const pathValid = looksLikeRepoPath(effectivePath);
  const ready = Boolean(trimmedTitle) && pathValid;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/documents`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filePath: effectivePath,
          content: `# ${trimmedTitle}\n`,
          commitMessage: `Create ${effectivePath}`,
        }),
      });

      const data = (await response.json().catch(() => ({}))) as ServerErrorPayload & { filePath?: string };
      if (!response.ok) {
        setError(describeServerError(t, data) ?? t('viewer.error.createFailed'));
        setSubmitting(false);
        return;
      }

      // A full load rather than a soft navigation, for the reason the delete
      // handler gives: the file tree is fetched once per workspace, so a
      // pushState would land on a document the sidebar does not know exists.
      //
      // `submitting` is left on: assigning `location.href` does not tear the
      // page down at once, and a form that came back to life in between invites
      // a second submit that would 409 against the document just created.
      window.location.href = docsPath(workspaceId, data.filePath ?? effectivePath);
    } catch {
      setError(t('viewer.error.createFailed'));
      setSubmitting(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: matches CommitDialog — a native <dialog> would need showModal()
    <div className="commit-dialog-backdrop" role="dialog" aria-modal="true" aria-label={t('newDoc.aria.dialog')}>
      <form className="commit-dialog" onSubmit={handleSubmit}>
        <h2 className="commit-dialog-title">{t('newDoc.title')}</h2>
        {branch && (
          <p className="commit-dialog-subtitle">
            {fillNodes(t('newDoc.body.onBranch'), { branch: <code>{branch}</code> })}
          </p>
        )}
        <label className="commit-dialog-label" htmlFor="new-document-title">
          {t('newDoc.label.title')}
        </label>
        <input
          ref={titleRef}
          id="new-document-title"
          className="commit-dialog-input"
          type="text"
          autoComplete="off"
          value={title}
          onChange={(event) => handleTitleChange(event.target.value)}
          disabled={submitting}
        />
        <label className="commit-dialog-label" htmlFor="new-document-path">
          {t('newDoc.label.path')}
        </label>
        <input
          id="new-document-path"
          className="commit-dialog-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={filePath}
          placeholder={suggestedPath}
          onChange={(event) => {
            setPathEdited(true);
            setFilePath(event.target.value);
          }}
          disabled={submitting}
        />
        {suggestion.examples.length > 0 && (
          <p className="commit-dialog-hint">
            {t('fileName.hint.siblings', { examples: suggestion.examples.join(', ') })}
          </p>
        )}
        {trimmedPath && !pathValid && <p className="commit-dialog-error">{t('newDoc.error.path')}</p>}
        {/* Already in the reader's language: the submit handler runs the
            server's code through `describeServerError` first. */}
        {error && <p className="commit-dialog-error">{error}</p>}
        <div className="commit-dialog-actions">
          <button type="button" className="doc-button doc-button-ghost" onClick={onCancel} disabled={submitting}>
            {t('common.button.cancel')}
          </button>
          <button type="submit" className="doc-button doc-button-primary" disabled={submitting || !ready}>
            {submitting ? t('newDoc.button.submitting') : t('newDoc.button.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
