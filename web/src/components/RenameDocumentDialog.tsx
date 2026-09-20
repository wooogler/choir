import { useEffect, useMemo, useRef, useState } from 'react';
import { type ServerErrorPayload, describeServerError, fillNodes, useT } from '../i18n';
import type { DocFile } from '../types';
import { docsPath, folderOf, formatTitle, looksLikeRepoPath, siblingNames } from '../utils/docs';
import { suggestFileNameFromSiblings } from '../utils/file-names';

/**
 * Renaming — and, by the same field, moving — a document.
 *
 * One input, prefilled with the path as it stands, because the common case is
 * fixing a basename and the uncommon case is typing a different folder in front
 * of it. Clearing the field falls back to the name the target folder's own
 * convention would have chosen (`suggestFileNameFromSiblings`), which is the
 * whole point of renaming a file that was created before the folder settled on
 * one.
 *
 * What the server knows and the reader does not is asked for while they type:
 * whether the target is taken, whether a Google Docs review is open (which the
 * rename would strand, so it is refused), and how many documents link to this
 * one — links the first pass deliberately does not rewrite, so saying nothing
 * would be the only real surprise here. See docs/meeting-notes-and-glossary.md,
 * "전제 기능: 문서 이름 변경·이동".
 */

type RenameDocumentDialogProps = {
  workspaceId: string;
  currentPath: string;
  /** The whole file listing; the target folder's siblings are read off it. */
  files: DocFile[];
  onCancel: () => void;
};

/** What `POST /documents/rename/check` answers, before anything is committed. */
type RenameCheck = {
  from: string;
  to: string;
  exists: boolean;
  reviewPending: boolean;
  inboundLinks: number;
  sameFolder: boolean;
};

/** How long to wait after the last keystroke before asking the server. */
const CHECK_DEBOUNCE_MS = 400;

export function RenameDocumentDialog({ workspaceId, currentPath, files, onCancel }: RenameDocumentDialogProps) {
  const t = useT();
  const [newPath, setNewPath] = useState(currentPath);
  // Kept next to the path it was asked about: the server normalises the pair it
  // echoes back, so its `to` is not a reliable way to recognise a stale answer.
  const [check, setCheck] = useState<{ asked: string; result: RenameCheck } | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus with the basename selected: typing replaces the name and leaves the
  // folder alone, which is what "rename" means nine times out of ten.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const start = currentPath.lastIndexOf('/') + 1;
    const end = /\.md$/i.test(currentPath) ? currentPath.length - 3 : currentPath.length;
    input.setSelectionRange(start, Math.max(start, end));
  }, [currentPath]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel, submitting]);

  const trimmedPath = newPath.trim();
  // The folder being typed towards, which is the one whose convention counts.
  const targetFolder = folderOf(trimmedPath || currentPath);
  const siblings = useMemo(() => siblingNames(files, targetFolder, currentPath), [files, targetFolder, currentPath]);
  const suggestion = useMemo(
    () => suggestFileNameFromSiblings(siblings, { title: formatTitle(currentPath), fallback: 'untitled' }),
    [siblings, currentPath],
  );
  const suggestedPath = targetFolder ? `${targetFolder}/${suggestion.placeholder}` : suggestion.placeholder;

  const target = trimmedPath || suggestedPath;
  const pathValid = looksLikeRepoPath(target);
  const unchanged = target === currentPath;

  // Debounced, and answers for an older path are dropped rather than shown:
  // an "already exists" about a path nobody is typing any more is a lie.
  useEffect(() => {
    if (!pathValid || unchanged) {
      setCheck(null);
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);
    const timer = window.setTimeout(() => {
      fetch(`/api/docs/${encodeURIComponent(workspaceId)}/documents/rename/check`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: currentPath, to: target }),
      })
        .then(async (response) => {
          const data = (await response.json().catch(() => ({}))) as Partial<RenameCheck>;
          if (cancelled) return;
          // A refusal here is not worth a red line — the path check below has
          // already said what the reader can act on, and the submit is where
          // the server's own answer becomes the truth.
          setCheck(response.ok && typeof data.to === 'string' ? { asked: target, result: data as RenameCheck } : null);
        })
        .catch(() => {
          if (!cancelled) setCheck(null);
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, CHECK_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [workspaceId, currentPath, target, pathValid, unchanged]);

  // Only an answer about the path as it stands now may speak.
  const fresh = check?.asked === target ? check.result : null;
  const blocked = Boolean(fresh?.exists || fresh?.reviewPending);
  const ready = pathValid && !unchanged && !blocked;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/documents/rename`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: currentPath, to: target }),
      });

      const data = (await response.json().catch(() => ({}))) as ServerErrorPayload & { to?: string };
      if (!response.ok) {
        setError(describeServerError(t, data) ?? t('rename.error.failed'));
        setSubmitting(false);
        return;
      }

      // A full load, for the reason the delete and create handlers give: the
      // file tree is fetched once per workspace, so a soft navigation would
      // land on a path the sidebar still believes is somewhere else.
      //
      // `submitting` stays on — assigning `location.href` does not tear the
      // page down at once, and the second submit it would otherwise allow
      // would rename a document that is no longer there.
      window.location.href = docsPath(workspaceId, data.to ?? target);
    } catch {
      setError(t('rename.error.failed'));
      setSubmitting(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: matches CommitDialog — a native <dialog> would need showModal()
    <div className="commit-dialog-backdrop" role="dialog" aria-modal="true" aria-label={t('rename.aria.dialog')}>
      <form className="commit-dialog" onSubmit={handleSubmit}>
        <h2 className="commit-dialog-title">{t('rename.title')}</h2>
        <p className="commit-dialog-subtitle">{t('rename.body')}</p>
        <span className="commit-dialog-label">{t('rename.label.current')}</span>
        <p className="commit-dialog-readonly">
          <code>{currentPath}</code>
        </p>
        <label className="commit-dialog-label" htmlFor="rename-document-path">
          {t('rename.label.path')}
        </label>
        <input
          ref={inputRef}
          id="rename-document-path"
          className="commit-dialog-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={newPath}
          placeholder={suggestedPath}
          onChange={(event) => setNewPath(event.target.value)}
          disabled={submitting}
        />
        {suggestion.examples.length > 0 && (
          <p className="commit-dialog-hint">
            {t('fileName.hint.siblings', { examples: suggestion.examples.join(', ') })}
          </p>
        )}
        {trimmedPath && !pathValid && <p className="commit-dialog-error">{t('rename.error.path')}</p>}
        {pathValid && !unchanged && checking && <p className="commit-dialog-hint">{t('rename.checking')}</p>}
        {fresh?.exists && (
          <p className="commit-dialog-error">{fillNodes(t('rename.error.exists'), { path: <code>{target}</code> })}</p>
        )}
        {fresh?.reviewPending && <p className="commit-dialog-error">{t('rename.error.reviewPending')}</p>}
        {fresh && fresh.inboundLinks > 0 && (
          <p className="commit-dialog-warning">{t('rename.warning.inboundLinks', { count: fresh.inboundLinks })}</p>
        )}
        {fresh && !fresh.sameFolder && (
          <p className="commit-dialog-hint">
            {fillNodes(t('rename.note.moveFolder'), {
              folder: <code>{folderOf(target) || t('rename.folder.root')}</code>,
            })}
          </p>
        )}
        {/* Already in the reader's language: the submit handler runs the
            server's code through `describeServerError` first. */}
        {error && <p className="commit-dialog-error">{error}</p>}
        <div className="commit-dialog-actions">
          <button type="button" className="doc-button doc-button-ghost" onClick={onCancel} disabled={submitting}>
            {t('common.button.cancel')}
          </button>
          <button type="submit" className="doc-button doc-button-primary" disabled={submitting || !ready}>
            {submitting ? t('rename.button.submitting') : t('rename.button.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
