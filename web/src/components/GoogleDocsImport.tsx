import { useCallback, useEffect, useState } from 'react';
import type { ImportStep } from '../../../services/google/import-steps';
import { type ServerErrorPayload, type T, describeServerError, useT } from '../i18n';
import { docsPath, looksLikeRepoPath, suggestFileName } from '../utils/docs';
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

type ImportResponse = ServerErrorPayload & {
  githubPath?: string;
  linked?: boolean;
  rejectedAssets?: Array<{ reason: string; contentType: string; bytes: number }>;
};

/** One line of the NDJSON the import endpoint streams while it works. */
type ImportEvent =
  | { type: 'progress'; step: string; index: number; total: number; label: string }
  | ({ type: 'result' } & ImportResponse)
  | ({ type: 'error'; status?: number } & ServerErrorPayload);

type Progress = { step: string; label: string; index: number; total: number };

const IMPORT_STREAM_TYPE = 'application/x-ndjson';

/**
 * The import's steps, keyed by the `step` the stream carries rather than by the
 * `label` beside it: the label is the server's own English, written before
 * anyone knew who would be watching the bar.
 */
const STEP_KEY = {
  checking: 'import.step.checking',
  reading: 'import.step.reading',
  committing: 'import.step.committing',
  mirroring: 'import.step.mirroring',
  linking: 'import.step.linking',
  done: 'import.step.done',
} as const satisfies Record<ImportStep, Parameters<T>[0]>;

/**
 * A server newer than this bundle can stream a step the catalog has no word
 * for. Its English `label` is a better answer there than a blank bar.
 */
function describeStep(t: T, progress: Progress): string {
  const key = STEP_KEY[progress.step as ImportStep];
  return key ? t(key) : progress.label;
}

export function GoogleDocsImport({ workspaceId }: { workspaceId: string }) {
  const t = useT();
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
      const picked = await pickGoogleDoc(workspaceId, t);
      if (!picked) return;

      const target = window.prompt(
        t('gdocs.import.prompt', { name: picked.name || t('gdocs.import.thisDocument') }),
        suggestFileName(picked.name, 'imported-document'),
      );
      if (target === null) return;
      if (!looksLikeRepoPath(target)) {
        setError(t('gdocs.import.error.path'));
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
            setProgress({ step: event.step, label: event.label, index: event.index, total: event.total });
          } else if (event.type === 'error') {
            throw new Error(describeServerError(t, event) ?? t('gdocs.import.error.failed'));
          } else if (event.type === 'result') {
            result = event;
          }
        }
        if (!result) throw new Error(t('gdocs.import.error.interrupted'));
      } else {
        result = (await response.json()) as ImportResponse;
        if (!response.ok) throw new Error(describeServerError(t, result) ?? t('gdocs.import.error.failed'));
      }

      if (result.rejectedAssets?.length) {
        const reasons = result.rejectedAssets
          .map(
            (asset) =>
              `• ${
                describeServerError(t, {
                  error: asset.reason,
                  detail: { contentType: asset.contentType, bytes: asset.bytes },
                }) ?? asset.reason
              }`,
          )
          .join('\n');
        window.alert(t('gdocs.import.rejectedAssets', { count: result.rejectedAssets.length, reasons }));
      }
      // A full load rather than a soft navigation: the file tree is fetched once
      // per workspace, so a pushState would land on a document the sidebar does
      // not yet know exists.
      window.location.href = docsPath(workspaceId, result.githubPath ?? target.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('gdocs.import.error.failed'));
    } finally {
      setBusy(false);
      setImporting(false);
      setProgress(null);
    }
  }, [workspaceId, t]);

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
        <span className="file-label">
          {busy ? t('gdocs.import.button.importing') : t('gdocs.import.button.import')}
        </span>
      </button>
      {importing && (
        // Until the first step arrives the bar has nothing true to show, so it
        // sweeps instead of claiming a position.
        <div className="import-progress">
          <div
            className={`import-progress-track${progress ? '' : ' indeterminate'}`}
            role="progressbar"
            aria-label={t('gdocs.import.aria.progress')}
            aria-valuemin={0}
            aria-valuemax={progress ? progress.total : undefined}
            aria-valuenow={progress ? progress.index : undefined}
            aria-valuetext={progress ? describeStep(t, progress) : undefined}
            // Not keyboard-reachable on purpose: there is nothing to operate,
            // and the label below it carries the same words the bar shows.
            tabIndex={-1}
          >
            <div className="import-progress-fill" style={progress ? { width: `${percent}%` } : undefined} />
          </div>
          <div className="import-progress-label" aria-live="polite">
            {progress ? describeStep(t, progress) : t('gdocs.import.starting')}
          </div>
        </div>
      )}
      {/* Already in the reader's language: every throw above runs the server's
          code through `describeServerError` first. */}
      {error && (
        <div className="sidebar-subtitle" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
