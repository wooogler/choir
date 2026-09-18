import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import {
  type DraftResult,
  type ImportProgress,
  type ImportStatus,
  type PdfUpload,
  convertUrl,
  describeImportError,
  fetchImportStatus,
  uploadPdf,
} from '../utils/import-api';
import { GoogleDocsImport } from './GoogleDocsImport';
import { ImportPreviewDialog } from './ImportPreviewDialog';
import { ImportProgressBar } from './ImportProgress';
import { PdfEstimateDialog } from './PdfEstimateDialog';

/**
 * The sidebar's one door into importing: Google Docs, a PDF, a web page.
 *
 * Three sources with one landing place, so they belong under one entry rather
 * than as three permanent rows in a sidebar whose job is listing documents. The
 * Google Docs button is the component that already existed, rendered inside the
 * menu unchanged — it keeps its own availability check (Google configured and
 * connected), its own progress bar and its own commit path.
 *
 * Whether any of this is offered at all is the server's answer, not a prop:
 * `import/status` knows about manager rights, push access and the PDF limits,
 * and a request that fails is read as "no" so the menu stays hidden rather than
 * offering buttons that would 403.
 */

type ImportMenuProps = { workspaceId: string };

/** The stage the import is at; only one of these is open at a time. */
type Stage =
  | { kind: 'idle' }
  | { kind: 'url' }
  | { kind: 'estimate'; upload: PdfUpload }
  | { kind: 'preview'; draft: DraftResult };

export function ImportMenu({ workspaceId }: ImportMenuProps) {
  const t = useT();
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchImportStatus(workspaceId);
      if (!cancelled) setStatus(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // A failure is worth reading, but not forever — same as the Google Docs
  // import, whose error sits in the same place.
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 8000);
    return () => window.clearTimeout(timer);
  }, [error]);

  // A menu that stays open behind a dialog, or after the pointer has gone
  // somewhere else, is a menu nobody asked for.
  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', handlePointer);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handlePointer);
      window.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const handleFile = useCallback(
    async (file: File) => {
      if (!status) return;
      const looksPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      if (!looksPdf) {
        setError(t('import.error.notPdf'));
        return;
      }
      // Checked here as well as on the server: a 20MB upload that is refused
      // after it finishes wastes the manager's time and their connection.
      if (status.pdf.maxBytes > 0 && file.size > status.pdf.maxBytes) {
        setError(t('import.error.tooLarge', { limit: Math.floor(status.pdf.maxBytes / (1024 * 1024)) }));
        return;
      }

      setOpen(false);
      setUploading(true);
      setError(null);
      try {
        const upload = await uploadPdf(workspaceId, file);
        setStage({ kind: 'estimate', upload });
      } catch (err) {
        setError(describeImportError(t, err, t('import.error.upload')));
      } finally {
        setUploading(false);
      }
    },
    [status, workspaceId, t],
  );

  if (!status?.canImport) return null;

  return (
    <div className="import-menu" ref={menuRef}>
      <button
        type="button"
        className="file-link insights-link"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={uploading}
      >
        <span className="file-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 1.75a.75.75 0 0 1 .75.75v5.94l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V2.5A.75.75 0 0 1 8 1.75ZM2.75 10a.75.75 0 0 1 .75.75v1.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-1.5a.75.75 0 0 1 .75-.75Z"
            />
          </svg>
        </span>
        <span className="file-label">{uploading ? t('import.menu.uploading') : t('import.menu.button')}</span>
      </button>

      {open && (
        <div className="import-menu-items" role="menu" aria-label={t('import.menu.aria')}>
          {/* The Google Docs import as it already is: its own status check, its
              own progress bar, its own path prompt. */}
          <GoogleDocsImport workspaceId={workspaceId} />
          <button
            type="button"
            className="file-link insights-link import-menu-item"
            role="menuitem"
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="file-label">{t('import.menu.fromPdf')}</span>
          </button>
          <button
            type="button"
            className="file-link insights-link import-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setStage({ kind: 'url' });
            }}
          >
            <span className="file-label">{t('import.menu.fromUrl')}</span>
          </button>
        </div>
      )}

      {uploading && (
        // The upload has no steps to report — it is one request — so the bar
        // sweeps until the estimate comes back.
        <ImportProgressBar
          progress={null}
          ariaLabel={t('import.menu.aria.upload')}
          startingLabel={t('import.menu.uploading')}
        />
      )}

      {/* Already in the reader's language: the handlers run the server's code
          through `describeServerError` first. */}
      {error && (
        <div className="sidebar-subtitle" role="alert">
          {error}
        </div>
      )}

      <input
        ref={fileInputRef}
        className="import-file-input"
        type="file"
        accept="application/pdf,.pdf"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file twice still fires a change.
          event.target.value = '';
          if (file) void handleFile(file);
        }}
      />

      {stage.kind === 'url' && (
        <UrlImportDialog
          workspaceId={workspaceId}
          onCancel={() => setStage({ kind: 'idle' })}
          onConverted={(draft) => setStage({ kind: 'preview', draft })}
        />
      )}
      {stage.kind === 'estimate' && (
        <PdfEstimateDialog
          workspaceId={workspaceId}
          upload={stage.upload}
          llm={status.pdf.llm}
          onCancel={() => setStage({ kind: 'idle' })}
          onConverted={(draft) => setStage({ kind: 'preview', draft })}
        />
      )}
      {stage.kind === 'preview' && (
        <ImportPreviewDialog
          workspaceId={workspaceId}
          draft={stage.draft}
          onCancel={() => setStage({ kind: 'idle' })}
        />
      )}
    </div>
  );
}

/**
 * Asking for the address, and converting it.
 *
 * A dialog rather than `window.prompt` (which the Google Docs import still
 * uses): the conversion takes seconds and streams its steps, and a prompt has
 * nowhere to put a progress bar or a refusal.
 */
function UrlImportDialog({
  workspaceId,
  onCancel,
  onConverted,
}: {
  workspaceId: string;
  onCancel: () => void;
  onConverted: (draft: DraftResult) => void;
}) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleCancel = useCallback(() => {
    if (converting) return;
    onCancel();
  }, [converting, onCancel]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleCancel]);

  const trimmed = url.trim();
  const valid = /^https?:\/\/\S+$/i.test(trimmed);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (converting || !valid) return;
    setConverting(true);
    setProgress(null);
    setError(null);
    try {
      const draft = await convertUrl(workspaceId, trimmed, setProgress);
      onConverted(draft);
    } catch (err) {
      setError(describeImportError(t, err, t('import.error.convert')));
      setConverting(false);
      setProgress(null);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: matches CommitDialog — a native <dialog> would need showModal()
    <div className="commit-dialog-backdrop" role="dialog" aria-modal="true" aria-label={t('import.url.aria.dialog')}>
      <form className="commit-dialog" onSubmit={handleSubmit}>
        <h2 className="commit-dialog-title">{t('import.url.title')}</h2>
        <p className="commit-dialog-subtitle">{t('import.url.subtitle')}</p>
        <label className="commit-dialog-label" htmlFor="import-url-input">
          {t('import.url.label')}
        </label>
        <input
          ref={inputRef}
          id="import-url-input"
          className="commit-dialog-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('import.url.placeholder')}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={converting}
        />
        {trimmed && !valid && <p className="commit-dialog-error">{t('import.error.url')}</p>}

        {/* Already in the reader's language: the submit handler runs the
            server's code through `describeServerError` first. */}
        {error && <p className="commit-dialog-error">{error}</p>}
        {converting && (
          <ImportProgressBar
            progress={progress}
            ariaLabel={t('import.url.aria.progress')}
            startingLabel={t('import.url.starting')}
          />
        )}

        <div className="commit-dialog-actions">
          <button type="button" className="doc-button doc-button-ghost" onClick={handleCancel} disabled={converting}>
            {t('common.button.cancel')}
          </button>
          <button type="submit" className="doc-button doc-button-primary" disabled={converting || !valid}>
            {converting ? t('import.url.button.converting') : t('import.url.button.convert')}
          </button>
        </div>
      </form>
    </div>
  );
}
