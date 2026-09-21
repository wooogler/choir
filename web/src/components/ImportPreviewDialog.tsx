import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type T, describeServerError, useT } from '../i18n';
import { docsPath, looksLikeRepoPath } from '../utils/docs';
import {
  type DraftResult,
  type ImportGlossaryRow,
  type ImportProgress,
  type ImportWarning,
  commitDraft,
  describeImportError,
  discardDraft,
  restoreAssetPaths,
  rewriteAssetUrlsForPreview,
} from '../utils/import-api';
import { CrepeEditor, type CrepeEditorHandle } from './CrepeEditor';
import { ImportProgressBar } from './ImportProgress';

/**
 * The step between converting a source and committing it.
 *
 * PDF and web conversions lose and interpret things that a Google Docs export
 * does not, so a manager sees what would be committed — in the ordinary editor,
 * editable — before it becomes a document. The warnings above it are advice,
 * never a block: whether a fidelity score of 0.7 is good enough for this
 * particular handbook is a judgement, and the person reading it is the one who
 * can make it.
 *
 * Images are the one thing the editor cannot show as written: the draft's
 * `assets/<hash>.png` files are not in the repository yet, so the markdown
 * handed to the editor points at the draft endpoint and is put back before the
 * commit (`rewriteAssetUrlsForPreview` / `restoreAssetPaths`).
 */

type ImportPreviewDialogProps = {
  workspaceId: string;
  draft: DraftResult;
  /**
   * Cards to show under the warnings — the meeting note's unknown terms, and
   * whatever a later source needs. Optional, so the PDF and URL flows that
   * have nothing extra to say are unchanged.
   */
  extraCards?: ReactNode;
  /**
   * Glossary rows to commit alongside the document, asked for at the moment
   * the manager presses Import — the card that produces them is live until
   * then. An empty list sends no `glossary` field at all.
   */
  glossaryRowsProvider?: () => ImportGlossaryRow[];
  /** Closing without importing; the caller drops its draft state. */
  onCancel: () => void;
};

/** How the source is named at the top of the dialog. */
function describeSource(t: T, draft: DraftResult): string {
  const name = draft.source.name || draft.title;
  if (draft.source.kind === 'pdf') {
    return draft.source.pages
      ? t('import.preview.source.pdfPages', { name, count: draft.source.pages })
      : t('import.preview.source.pdf', { name });
  }
  if (draft.source.kind === 'meeting') {
    // The transcript's size, the way pages describe a PDF's: how long the
    // meeting ran and how many people spoke.
    const parts = [t('meeting.preview.source', { name })];
    if (draft.source.minutes) parts.push(t('meeting.preview.source.minutes', { count: draft.source.minutes }));
    if (draft.source.speakers) parts.push(t('meeting.preview.source.speakers', { count: draft.source.speakers }));
    return parts.join(' · ');
  }
  return t('import.preview.source.url', { name });
}

/**
 * A warning in the reader's language.
 *
 * `detail` is the server's, and an older (or newer) server may not send the
 * number a sentence wants — so each code that has a hole also has a plain
 * sentence to fall back on, rather than showing a literal `{count}`.
 */
function describeWarning(t: T, warning: ImportWarning, rejectedCount: number): string {
  const detail = warning.detail ?? {};
  const number = (value: string | number | undefined): number | undefined => {
    const parsed = typeof value === 'string' ? Number(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
  };

  switch (warning.code) {
    case 'low_fidelity': {
      const score = number(detail.score);
      return score === undefined
        ? t('import.warning.low_fidelity.plain')
        : t('import.warning.low_fidelity', { score: Math.round((score <= 1 ? score * 100 : score) * 10) / 10 });
    }
    case 'scanned_pages': {
      const count = number(detail.count) ?? number(detail.pages);
      return count === undefined
        ? t('import.warning.scanned_pages.plain')
        : t('import.warning.scanned_pages', { count });
    }
    case 'readability_fallback':
      return t('import.warning.readability_fallback');
    case 'images_rejected': {
      const count = number(detail.count) ?? rejectedCount;
      return count > 0 ? t('import.warning.images_rejected', { count }) : t('import.warning.images_rejected.plain');
    }
    case 'truncated':
      return t('import.warning.truncated');
    default:
      // A warning this bundle has no word for is still worth showing: the code
      // is at least a thing to search for.
      return warning.code;
  }
}

/** Minutes left on the draft, floored at zero. */
function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

export function ImportPreviewDialog({
  workspaceId,
  draft,
  extraCards,
  glossaryRowsProvider,
  onCancel,
}: ImportPreviewDialogProps) {
  const t = useT();
  const [filePath, setFilePath] = useState(draft.suggestedPath);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const editorRef = useRef<CrepeEditorHandle | null>(null);

  // Rewritten once and never again: CrepeEditor rebuilds itself when its
  // `markdown` prop changes, which would throw away everything typed since.
  const [previewMarkdown] = useState(() => rewriteAssetUrlsForPreview(draft.markdown, workspaceId, draft.draftId));

  const trimmedPath = filePath.trim();
  const pathValid = looksLikeRepoPath(trimmedPath);
  const remaining = minutesLeft(draft.expiresAt, now);
  const expired = remaining <= 0;

  // The draft dies on the server whether or not this dialog is open, so the
  // countdown is shown rather than discovered at commit time.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  const handleCancel = useCallback(() => {
    if (submitting) return;
    // Best effort: an unclaimed draft expires by itself either way.
    discardDraft(workspaceId, draft.draftId);
    onCancel();
  }, [submitting, workspaceId, draft.draftId, onCancel]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleCancel]);

  const warnings = useMemo(
    () =>
      draft.warnings.map((warning, index) => ({
        key: `${warning.code}-${index}`,
        sentence: describeWarning(t, warning, draft.rejectedAssets.length),
      })),
    [draft.warnings, draft.rejectedAssets.length, t],
  );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || !pathValid) return;

    setSubmitting(true);
    setProgress(null);
    setError(null);
    try {
      const edited = editorRef.current?.getMarkdown() ?? previewMarkdown;
      const markdown = restoreAssetPaths(edited, workspaceId, draft.draftId);
      // Asked for now rather than held as state: the card is editable right up
      // to this press, and what it holds at this moment is the answer.
      const glossaryRows = glossaryRowsProvider?.() ?? [];
      const result = await commitDraft(
        workspaceId,
        {
          draftId: draft.draftId,
          filePath: trimmedPath,
          markdown,
          ...(glossaryRows.length > 0 ? { glossary: { rows: glossaryRows } } : {}),
        },
        setProgress,
      );

      // Both of these land before the navigation below, which tears the page
      // down: a sentence shown after it would never be read.
      if (result.glossary) {
        const committed = result.glossary;
        window.alert(
          [
            committed.created
              ? t('meeting.glossaryCard.committed.created', { count: committed.added, path: committed.path })
              : t('meeting.glossaryCard.committed', { count: committed.added, path: committed.path }),
            committed.skipped.length > 0
              ? t('meeting.glossaryCard.committed.skipped', {
                  count: committed.skipped.length,
                  terms: committed.skipped.join(', '),
                })
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }

      if (result.droppedReferences?.length) {
        window.alert(
          t('import.preview.droppedReferences', {
            count: result.droppedReferences.length,
            references: result.droppedReferences.join('\n'),
          }),
        );
      }

      // A full load rather than a soft navigation, for the reason the Google
      // Docs import gives: the file tree is fetched once per workspace, so a
      // pushState would land on a document the sidebar does not know exists.
      // `submitting` stays on — the document is already committed, and a form
      // that came back to life would 409 against it.
      window.location.href = docsPath(workspaceId, result.githubPath || trimmedPath);
    } catch (err) {
      setError(describeImportError(t, err, t('import.error.commit')));
      setSubmitting(false);
      setProgress(null);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: matches CommitDialog — a native <dialog> would need showModal()
    <div
      className="commit-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('import.preview.aria.dialog')}
    >
      <form className="commit-dialog commit-dialog-wide" onSubmit={handleSubmit}>
        <h2 className="commit-dialog-title">{t('import.preview.title')}</h2>
        <p className="commit-dialog-subtitle">
          {describeSource(t, draft)}
          {draft.source.url && (
            <>
              {' · '}
              <a href={draft.source.url} rel="noreferrer noopener" target="_blank">
                {draft.source.url}
              </a>
            </>
          )}
        </p>

        {warnings.length > 0 && (
          <div className="import-warnings">
            <div className="import-warnings-title">{t('import.preview.warnings.title')}</div>
            <ul className="import-warnings-list">
              {warnings.map((warning) => (
                <li key={warning.key}>{warning.sentence}</li>
              ))}
            </ul>
          </div>
        )}

        {draft.rejectedAssets.length > 0 && (
          <div className="import-warnings">
            <div className="import-warnings-title">
              {t('import.preview.rejectedAssets', { count: draft.rejectedAssets.length })}
            </div>
            <ul className="import-warnings-list">
              {draft.rejectedAssets.map((asset) => (
                <li key={`${asset.reason}-${asset.contentType}-${asset.bytes}`}>
                  {describeServerError(t, {
                    error: asset.reason,
                    detail: { contentType: asset.contentType, bytes: asset.bytes },
                  }) ?? asset.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {extraCards}

        <label className="commit-dialog-label" htmlFor="import-preview-path">
          {t('import.preview.label.path')}
        </label>
        <input
          id="import-preview-path"
          className="commit-dialog-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={filePath}
          onChange={(event) => setFilePath(event.target.value)}
          disabled={submitting}
        />
        {trimmedPath && !pathValid && <p className="commit-dialog-error">{t('import.error.path')}</p>}

        <div className="import-preview-editor">
          <CrepeEditor
            ref={editorRef}
            markdown={previewMarkdown}
            editable={!submitting}
            workspaceId={workspaceId}
            // The document does not exist yet, so the path being typed above is
            // the best answer to "where will this live": it is what any image
            // the manager adds here is made relative to.
            filePath={trimmedPath || draft.suggestedPath}
          />
        </div>

        {/* Already in the reader's language: every failure above runs the
            server's code through `describeServerError` first. */}
        {error && <p className="commit-dialog-error">{error}</p>}
        {submitting && (
          <ImportProgressBar
            progress={progress}
            ariaLabel={t('import.preview.aria.progress')}
            startingLabel={t('import.preview.starting')}
          />
        )}

        <div className="commit-dialog-actions">
          <span className="import-preview-expiry">
            {expired ? t('import.preview.expired') : t('import.preview.expires', { count: remaining })}
          </span>
          <button type="button" className="doc-button doc-button-ghost" onClick={handleCancel} disabled={submitting}>
            {t('common.button.cancel')}
          </button>
          <button type="submit" className="doc-button doc-button-primary" disabled={submitting || !pathValid}>
            {submitting ? t('import.preview.button.importing') : t('import.preview.button.import')}
          </button>
        </div>
      </form>
    </div>
  );
}
