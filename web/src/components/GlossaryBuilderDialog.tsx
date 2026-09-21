import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { docsPath } from '../utils/docs';
import {
  type GlossaryCandidateKind,
  type GlossaryCreateAt,
  type GlossaryStatus,
  commitGlossaryRows,
  describeGlossaryError,
  extractGlossaryTerms,
  fetchGlossaryStatus,
} from '../utils/glossary-api';
import {
  type ImportProgress,
  type PdfUpload,
  convertPdf,
  convertUrl,
  describeImportError,
  discardDraft,
  uploadPdf,
} from '../utils/import-api';
import { ImportProgressBar } from './ImportProgress';

/**
 * "용어집 만들기" — a glossary started from documents somebody already has.
 *
 * Asking a manager to fill in an empty table is how a glossary never gets
 * written (docs/meeting-notes-and-glossary.md §3a). So the dialog takes seed
 * documents instead — a paper, a deck, a handbook page — converts them with
 * the import sources the viewer already has, and asks the model for the terms
 * they define. What comes back is a proposal: every row is editable and
 * deletable before anything is committed, because a model reading a paper for
 * vocabulary is a suggestion, not an authority.
 *
 * The seed documents are never committed. They become import drafts, the
 * extraction reads their markdown, and the drafts are dropped when this closes.
 */

type GlossaryBuilderDialogProps = {
  workspaceId: string;
  /** Where the terms should land; editable, and the chain is read for it. */
  folder: string;
  onClose: () => void;
};

/** A converted seed document, waiting to be read for terms. */
type Seed = {
  draftId: string;
  title: string;
  kind: 'pdf' | 'url';
};

/** One line of the editable table. Aliases are comma-separated while editing. */
type Row = {
  id: number;
  term: string;
  aliases: string;
  description: string;
  kind?: GlossaryCandidateKind;
  source?: string;
};

/** `as const` so each value stays a literal `MessageKey`. */
const KIND_LABEL = {
  acronym: 'glossaryBuilder.kind.acronym',
  'proper-noun': 'glossaryBuilder.kind.properNoun',
  concept: 'glossaryBuilder.kind.concept',
} as const;

function normalizeFolder(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

export function GlossaryBuilderDialog({ workspaceId, folder: initialFolder, onClose }: GlossaryBuilderDialogProps) {
  const t = useT();

  const [folder, setFolder] = useState(() => normalizeFolder(initialFolder));
  const [status, setStatus] = useState<GlossaryStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const [seeds, setSeeds] = useState<Seed[]>([]);
  const [pdfUpload, setPdfUpload] = useState<PdfUpload | null>(null);
  const [url, setUrl] = useState('');

  const [rows, setRows] = useState<Row[] | null>(null);
  const [createAt, setCreateAt] = useState<GlossaryCreateAt>('nearest');
  const [result, setResult] = useState<{ path: string; added: number; skipped: string[]; created: boolean } | null>(
    null,
  );

  const [uploading, setUploading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nextRowId = useRef(0);
  // Read by the unmount cleanup, which must not re-run every time a seed is
  // added — a cleanup that fires then would discard the draft it just made.
  const seedsRef = useRef<Seed[]>([]);
  seedsRef.current = seeds;

  const busy = uploading || converting || extracting || saving;
  const normalized = normalizeFolder(folder);

  const handleClose = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleClose]);

  // The seed drafts are the server's to hold and ours to drop: they are never
  // committed, and an abandoned one would otherwise sit there until it expires.
  useEffect(() => {
    return () => {
      for (const seed of seedsRef.current) discardDraft(workspaceId, seed.draftId);
    };
  }, [workspaceId]);

  // What this folder already has. Re-read as the folder is typed, behind a
  // short pause so every keystroke is not a request.
  useEffect(() => {
    let cancelled = false;
    setStatusLoading(true);
    const timer = window.setTimeout(() => {
      fetchGlossaryStatus(workspaceId, normalized)
        .then((value) => {
          if (cancelled) return;
          setStatus(value);
          setCreateAt(value.nearestFile ? 'nearest' : 'folder');
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        })
        .finally(() => {
          if (!cancelled) setStatusLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [workspaceId, normalized]);

  const addSeed = (seed: Seed) => setSeeds((current) => [...current, seed]);

  const removeSeed = (draftId: string) => {
    discardDraft(workspaceId, draftId);
    setSeeds((current) => current.filter((seed) => seed.draftId !== draftId));
  };

  const handlePdf = async (file: File) => {
    if (busy) return;
    setUploading(true);
    setError(null);
    try {
      setPdfUpload(await uploadPdf(workspaceId, file));
    } catch (err) {
      setError(describeImportError(t, err, t('import.error.upload')));
    } finally {
      setUploading(false);
    }
  };

  const handleConvertPdf = async () => {
    if (busy || !pdfUpload) return;
    setConverting(true);
    setProgress(null);
    setError(null);
    try {
      const draft = await convertPdf(workspaceId, pdfUpload.uploadId, setProgress);
      addSeed({ draftId: draft.draftId, title: draft.title || draft.source.name, kind: 'pdf' });
      setPdfUpload(null);
    } catch (err) {
      setError(describeImportError(t, err, t('import.error.convert')));
    } finally {
      setConverting(false);
      setProgress(null);
    }
  };

  const handleUrl = async () => {
    const trimmed = url.trim();
    if (busy || !/^https?:\/\/\S+$/i.test(trimmed)) return;
    setConverting(true);
    setProgress(null);
    setError(null);
    try {
      const draft = await convertUrl(workspaceId, trimmed, setProgress);
      addSeed({ draftId: draft.draftId, title: draft.title || draft.source.name, kind: 'url' });
      setUrl('');
    } catch (err) {
      setError(describeImportError(t, err, t('import.error.convert')));
    } finally {
      setConverting(false);
      setProgress(null);
    }
  };

  const handleExtract = async () => {
    if (busy || seeds.length === 0) return;
    setExtracting(true);
    setError(null);
    try {
      const extracted = await extractGlossaryTerms(workspaceId, {
        folder: normalized,
        draftIds: seeds.map((seed) => seed.draftId),
      });
      setRows(
        extracted.candidates.map((candidate) => ({
          id: nextRowId.current++,
          term: candidate.term,
          aliases: candidate.aliases.join(', '),
          description: candidate.description,
          kind: candidate.kind,
          ...(candidate.source ? { source: candidate.source } : {}),
        })),
      );
      if (extracted.nearestFile === null) setCreateAt('folder');
    } catch (err) {
      setError(describeGlossaryError(t, err, t('glossaryBuilder.error.extract')));
    } finally {
      setExtracting(false);
    }
  };

  const updateRow = (id: number, patch: Partial<Row>) => {
    setRows((current) => (current ?? []).map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const handleSave = async () => {
    const usable = (rows ?? [])
      .map((row) => ({
        term: row.term.trim(),
        aliases: row.aliases
          .split(',')
          .map((alias) => alias.trim())
          .filter(Boolean),
        description: row.description.trim(),
      }))
      .filter((row) => row.term.length > 0);
    if (busy || usable.length === 0) return;

    setSaving(true);
    setError(null);
    try {
      const committed = await commitGlossaryRows(workspaceId, { folder: normalized, rows: usable, createAt });
      setResult({
        path: committed.path,
        added: committed.added,
        skipped: committed.skipped,
        created: committed.created,
      });
      setRows(null);
    } catch (err) {
      setError(describeGlossaryError(t, err, t('glossaryBuilder.error.save')));
    } finally {
      setSaving(false);
    }
  };

  const filledRows = (rows ?? []).filter((row) => row.term.trim().length > 0).length;
  // Captured rather than read inside the radio loop: property narrowing does
  // not survive into a callback.
  const nearestFile = status?.nearestFile ?? null;

  // Hoisted so the backdrop fits on one line: a multi-line element takes the
  // suppression comment below on its attribute rather than on itself.
  const dialogLabel = t('glossaryBuilder.aria.dialog');

  return (
    // biome-ignore lint/a11y/useSemanticElements: matches CommitDialog — a native <dialog> would need showModal()
    <div className="commit-dialog-backdrop" role="dialog" aria-modal="true" aria-label={dialogLabel}>
      <form
        className="commit-dialog commit-dialog-wide"
        onSubmit={(event) => {
          event.preventDefault();
          if (rows) void handleSave();
          else void handleExtract();
        }}
      >
        <h2 className="commit-dialog-title">{t('glossaryBuilder.title')}</h2>
        <p className="commit-dialog-subtitle">{t('glossaryBuilder.subtitle')}</p>

        {/* ── Where the terms land ── */}
        <label className="commit-dialog-label" htmlFor="glossary-folder">
          {t('glossaryBuilder.label.folder')}
        </label>
        <input
          id="glossary-folder"
          className="commit-dialog-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('glossaryBuilder.folder.rootPlaceholder')}
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          disabled={busy}
        />
        {statusLoading && <p className="commit-dialog-hint">{t('glossaryBuilder.status.loading')}</p>}
        {!statusLoading && status && (
          <p className="commit-dialog-hint">
            {status.files.length === 0
              ? t('glossaryBuilder.status.none')
              : t('glossaryBuilder.status.chain', {
                  files: status.files.join(', '),
                  count: status.entries,
                })}
          </p>
        )}

        {/* ── The seed documents ── */}
        {!result && (
          <>
            <span className="commit-dialog-label">{t('glossaryBuilder.label.seeds')}</span>
            {seeds.length === 0 && <p className="commit-dialog-hint">{t('glossaryBuilder.seeds.empty')}</p>}
            {seeds.length > 0 && (
              <ul className="glossary-seed-list">
                {seeds.map((seed) => (
                  <li className="glossary-seed" key={seed.draftId}>
                    <span className="project-tag">
                      {seed.kind === 'pdf' ? t('glossaryBuilder.seed.pdf') : t('glossaryBuilder.seed.url')}
                    </span>
                    <span className="glossary-seed-title">{seed.title}</span>
                    <button
                      type="button"
                      className="doc-button doc-button-ghost"
                      onClick={() => removeSeed(seed.draftId)}
                      disabled={busy}
                    >
                      {t('glossaryBuilder.seed.remove')}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {pdfUpload ? (
              <div className="import-warnings">
                <div className="import-warnings-title">{t('glossaryBuilder.seed.pdfEstimate.title')}</div>
                <p className="commit-dialog-hint">
                  {t('glossaryBuilder.seed.pdfEstimate.body', {
                    name: pdfUpload.filename,
                    pages: pdfUpload.estimate.pages,
                    tokens: pdfUpload.estimate.inputTokens,
                  })}
                </p>
                <div className="glossary-seed-actions">
                  <button
                    type="button"
                    className="doc-button doc-button-ghost"
                    onClick={() => setPdfUpload(null)}
                    disabled={busy}
                  >
                    {t('common.button.cancel')}
                  </button>
                  <button
                    type="button"
                    className="doc-button doc-button-primary"
                    onClick={() => void handleConvertPdf()}
                    disabled={busy}
                  >
                    {converting ? t('import.estimate.button.converting') : t('import.estimate.button.convert')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="glossary-seed-add">
                <button
                  type="button"
                  className="doc-button doc-button-ghost"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                >
                  {uploading ? t('import.menu.uploading') : t('glossaryBuilder.seed.addPdf')}
                </button>
                <input
                  className="commit-dialog-input glossary-seed-url"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('glossaryBuilder.seed.addUrl')}
                  placeholder={t('import.url.placeholder')}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter in this field means "add this page", not "save".
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleUrl();
                    }
                  }}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="doc-button doc-button-ghost"
                  onClick={() => void handleUrl()}
                  disabled={busy || !/^https?:\/\/\S+$/i.test(url.trim())}
                >
                  {t('glossaryBuilder.seed.addUrl')}
                </button>
              </div>
            )}

            <input
              ref={fileInputRef}
              className="import-file-input"
              type="file"
              accept="application/pdf,.pdf"
              tabIndex={-1}
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                event.target.value = '';
                if (chosen) void handlePdf(chosen);
              }}
            />
          </>
        )}

        {/* ── The proposed rows ── */}
        {rows && (
          <>
            <span className="commit-dialog-label">{t('glossaryBuilder.label.candidates')}</span>
            <div className="glossary-table-wrap">
              <table className="glossary-table">
                <thead>
                  <tr>
                    <th>{t('glossaryBuilder.column.term')}</th>
                    <th>{t('glossaryBuilder.column.aliases')}</th>
                    <th>{t('glossaryBuilder.column.description')}</th>
                    <th aria-label={t('glossaryBuilder.column.actions')} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <div className="glossary-term-cell">
                          <input
                            className="glossary-cell-input"
                            type="text"
                            autoComplete="off"
                            aria-label={t('glossaryBuilder.column.term')}
                            value={row.term}
                            onChange={(event) => updateRow(row.id, { term: event.target.value })}
                            disabled={busy}
                          />
                          {row.kind && (
                            <span className="project-tag" title={row.source ?? undefined}>
                              {t(KIND_LABEL[row.kind])}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <input
                          className="glossary-cell-input"
                          type="text"
                          autoComplete="off"
                          aria-label={t('glossaryBuilder.column.aliases')}
                          placeholder={t('glossaryBuilder.aliases.placeholder')}
                          value={row.aliases}
                          onChange={(event) => updateRow(row.id, { aliases: event.target.value })}
                          disabled={busy}
                        />
                      </td>
                      <td>
                        <input
                          className="glossary-cell-input"
                          type="text"
                          autoComplete="off"
                          aria-label={t('glossaryBuilder.column.description')}
                          value={row.description}
                          onChange={(event) => updateRow(row.id, { description: event.target.value })}
                          disabled={busy}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="glossary-row-delete"
                          aria-label={t('glossaryBuilder.row.delete.aria', { term: row.term })}
                          title={t('glossaryBuilder.row.delete')}
                          onClick={() => setRows((current) => (current ?? []).filter((entry) => entry.id !== row.id))}
                          disabled={busy}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              className="doc-button doc-button-ghost"
              onClick={() =>
                setRows((current) => [
                  ...(current ?? []),
                  { id: nextRowId.current++, term: '', aliases: '', description: '' },
                ])
              }
              disabled={busy}
            >
              {t('glossaryBuilder.row.add')}
            </button>

            {nearestFile && (
              <>
                <span className="commit-dialog-label">{t('glossaryBuilder.label.target')}</span>
                {(['nearest', 'folder'] as GlossaryCreateAt[]).map((value) => (
                  <label className="project-radio" key={value}>
                    <input
                      type="radio"
                      name="glossary-create-at"
                      checked={createAt === value}
                      onChange={() => setCreateAt(value)}
                      disabled={busy}
                    />
                    <span>
                      <span className="project-radio-title">
                        {value === 'nearest'
                          ? t('glossaryBuilder.target.nearest', { file: nearestFile })
                          : t('glossaryBuilder.target.folder')}
                      </span>
                    </span>
                  </label>
                ))}
              </>
            )}
          </>
        )}

        {/* ── What was written ── */}
        {result && (
          <div className="import-warnings">
            <div className="import-warnings-title">
              {result.created
                ? t('glossaryBuilder.result.created', { count: result.added })
                : t('glossaryBuilder.result.added', { count: result.added })}
            </div>
            <p className="commit-dialog-hint">
              <a href={docsPath(workspaceId, result.path)}>{result.path}</a>
            </p>
            {result.skipped.length > 0 && (
              <p className="commit-dialog-hint">
                {t('glossaryBuilder.result.skipped', {
                  count: result.skipped.length,
                  terms: result.skipped.join(', '),
                })}
              </p>
            )}
          </div>
        )}

        {/* Already in the reader's language: every handler runs the server's
            code through `describeServerError` first. */}
        {error && <p className="commit-dialog-error">{error}</p>}
        {(converting || extracting) && (
          <ImportProgressBar
            progress={progress}
            ariaLabel={t('glossaryBuilder.aria.progress')}
            startingLabel={extracting ? t('glossaryBuilder.extracting') : t('import.url.starting')}
          />
        )}

        <div className="commit-dialog-actions">
          <button type="button" className="doc-button doc-button-ghost" onClick={handleClose} disabled={busy}>
            {result ? t('common.button.close') : t('common.button.cancel')}
          </button>
          {!result && (
            <button
              type="submit"
              className="doc-button doc-button-primary"
              disabled={busy || (rows ? filledRows === 0 : seeds.length === 0)}
            >
              {rows
                ? saving
                  ? t('glossaryBuilder.button.saving')
                  : t('glossaryBuilder.button.save')
                : extracting
                  ? t('glossaryBuilder.button.extracting')
                  : t('glossaryBuilder.button.extract')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
