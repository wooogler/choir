import { useCallback, useEffect, useState } from 'react';
import { docsPath } from '../utils/docs';
import { readNdjson } from '../utils/ndjson';
import { pickGoogleDoc } from '../utils/picker';

/**
 * Sidebar control for bringing a Google Doc into the repository as a new
 * document.
 *
 * The counterpart to GoogleDocsSync, which points the other way: this one reads
 * a Doc and commits it, rather than replacing a Doc with what the repository
 * already has. Nothing is written to the Google Doc: it was somebody's document
 * before it was ours, so its fonts, layout and images are left exactly as they
 * are and only the sync bookkeeping is recorded. Edits made in the Doc from then
 * on come back through the ordinary review path, while changes made on the
 * CHOIR side are reported to a manager to apply rather than pushed over it.
 *
 * Workspace-level rather than per-document, because the document being created
 * does not exist yet.
 */

type ImportResponse = {
  githubPath?: string;
  linked?: boolean;
  rejectedAssets?: Array<{ reason: string; contentType: string; bytes: number }>;
  error?: string;
};

/** One line of the NDJSON the import endpoint streams while it works. */
type ImportEvent =
  | { type: 'progress'; step: string; index: number; total: number; label: string }
  | ({ type: 'result' } & ImportResponse)
  | { type: 'error'; error?: string; code?: string; status?: number };

type Progress = { label: string; index: number; total: number };

const IMPORT_STREAM_TYPE = 'application/x-ndjson';

/** Repo-relative, markdown, no traversal — mirrors the server's own check. */
function looksLikeRepoPath(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.startsWith('/')) return false;
  if (trimmed.split('/').includes('..')) return false;
  return /\.md$/i.test(trimmed);
}

/** Doc title → a filename someone would have typed. */
function suggestPath(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || 'imported-document'}.md`;
}

export function GoogleDocsImport({ workspaceId }: { workspaceId: string }) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  // Distinct from `busy`, which covers picking a document too: the bar belongs
  // to the request, not to the file picker sitting open in front of it.
  const [importing, setImporting] = useState(false);

  // Asks the server rather than taking props: the same endpoint answers whether
  // Google is configured, whether an account is connected, and — by refusing a
  // non-manager outright — whether this person may import at all.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/google/status`, {
          credentials: 'same-origin',
        });
        if (!response.ok) return;
        const status = (await response.json()) as { configured?: boolean; connected?: boolean; broken?: boolean };
        if (!cancelled) setAvailable(Boolean(status.configured && status.connected && !status.broken));
      } catch {
        // Leave the control hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // A failure is worth reading, but not forever.
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 8000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const picked = await pickGoogleDoc(workspaceId);
      if (!picked) return;

      const target = window.prompt(
        `Import "${picked.name || 'this document'}" into the repository as:`,
        suggestPath(picked.name),
      );
      if (target === null) return;
      if (!looksLikeRepoPath(target)) {
        setError('Give a repository-relative path ending in .md');
        return;
      }

      // Reading the Doc, committing it with its images, and writing the replica
      // back each take seconds, so ask for the step-by-step stream and show it.
      setImporting(true);
      const streamable = typeof ReadableStream === 'function';
      const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/google/import`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: streamable ? IMPORT_STREAM_TYPE : 'application/json',
        },
        body: JSON.stringify({ filePath: target.trim(), fileId: picked.fileId, pickerNonce: picked.pickerNonce }),
      });

      const streamed =
        Boolean(response.body) && (response.headers.get('Content-Type') ?? '').includes(IMPORT_STREAM_TYPE);

      let result: ImportResponse | null = null;
      if (streamed && response.body) {
        // The status line went out before the first step ran, so a streaming
        // import reports its outcome on the last line instead of in the status.
        for await (const event of readNdjson<ImportEvent>(response.body)) {
          if (event.type === 'progress') {
            setProgress({ label: event.label, index: event.index, total: event.total });
          } else if (event.type === 'error') {
            throw new Error(event.error || 'Could not import that document');
          } else if (event.type === 'result') {
            result = event;
          }
        }
        if (!result) throw new Error('The import stopped before it finished');
      } else {
        result = (await response.json()) as ImportResponse;
        if (!response.ok) throw new Error(result.error || 'Could not import that document');
      }

      if (result.rejectedAssets?.length) {
        const reasons = result.rejectedAssets.map((asset) => `• ${asset.reason}`).join('\n');
        window.alert(`Imported, but ${result.rejectedAssets.length} image(s) were left out:\n${reasons}`);
      }
      // A full load rather than a soft navigation: the file tree is fetched once
      // per workspace, so a pushState would land on a document the sidebar does
      // not yet know exists.
      window.location.href = docsPath(workspaceId, result.githubPath ?? target.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import that document');
    } finally {
      setBusy(false);
      setImporting(false);
      setProgress(null);
    }
  }, [workspaceId]);

  // Importing needs somewhere to read from; connecting a Google account is
  // offered on a document, where the consequences of linking are spelled out.
  if (!available) return null;

  const percent = progress ? Math.round((progress.index / progress.total) * 100) : 0;

  return (
    <>
      <button type="button" className="file-link insights-link" onClick={run} disabled={busy}>
        <span className="file-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 1.75a.75.75 0 0 1 .75.75v5.94l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V2.5A.75.75 0 0 1 8 1.75ZM2.75 10a.75.75 0 0 1 .75.75v1.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-1.5a.75.75 0 0 1 .75-.75Z"
            />
          </svg>
        </span>
        <span className="file-label">{busy ? 'Importing…' : 'Import from Google Docs'}</span>
      </button>
      {importing && (
        // Until the first step arrives the bar has nothing true to show, so it
        // sweeps instead of claiming a position.
        <div className="import-progress">
          <div
            className={`import-progress-track${progress ? '' : ' indeterminate'}`}
            role="progressbar"
            aria-label="Google Docs import"
            aria-valuemin={0}
            aria-valuemax={progress ? progress.total : undefined}
            aria-valuenow={progress ? progress.index : undefined}
            aria-valuetext={progress?.label}
            // Not keyboard-reachable on purpose: there is nothing to operate,
            // and the label below it carries the same words the bar shows.
            tabIndex={-1}
          >
            <div className="import-progress-fill" style={progress ? { width: `${percent}%` } : undefined} />
          </div>
          <div className="import-progress-label" aria-live="polite">
            {progress ? progress.label : 'Starting the import…'}
          </div>
        </div>
      )}
      {error && (
        <div className="sidebar-subtitle" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
