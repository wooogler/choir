import { useCallback, useEffect, useState } from 'react';
import { lineDiff } from '../utils/diff';

/**
 * Review panel for an edit somebody made in the Google Docs replica.
 *
 * The proposal is recomputed by the server on every load rather than cached, and
 * the decision is checked against the state it was rendered against. If the
 * repository or the document has moved, the server refuses and rebuilds — so a
 * stale panel can annoy a manager but cannot erase anyone's work.
 */

type Conflict = {
  reason: 'unmappable' | 'code-block' | 'merge';
  incoming: string[];
  current?: string[];
};

type Review = {
  githubPath: string;
  docUrl: string;
  status: 'ready' | 'no-change' | 'not-linked' | 'not-connected' | 'not-drifted' | 'baseline-lost';
  before?: string;
  after?: string;
  conflicts?: Conflict[];
  newAssets?: Array<{ hash: string; contentType: string; bytes: number }>;
  rejectedAssets?: Array<{ reason: string; contentType: string; bytes: number }>;
  editor?: string;
};

const CONFLICT_EXPLANATION: Record<Conflict['reason'], string> = {
  'code-block':
    'This edit touches a code block. Google Docs has no code blocks, so the export cannot say whether the change was meant for the code or the text around it.',
  unmappable: 'This text has no counterpart in the repository document, so there is no safe place to put it.',
  merge: 'The repository and Google Docs both changed this. The repository version is kept below.',
};

const STATUS_MESSAGE: Record<Exclude<Review['status'], 'ready'>, string> = {
  'no-change': 'Nothing has changed in the Google Doc.',
  'not-linked': 'This document is not linked to a Google Doc.',
  'not-connected': 'The workspace Google account is not connected.',
  'not-drifted': 'There is no pending Google Docs edit for this document.',
  'baseline-lost':
    'The comparison snapshot for this document is missing, so the edit cannot be worked out. Unlink and relink the document to start again.',
};

export function GoogleDocsReview({
  workspaceId,
  filePath,
  onClose,
  onApplied,
}: {
  workspaceId: string;
  filePath: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(
        `/api/docs/${encodeURIComponent(workspaceId)}/google/review?filePath=${encodeURIComponent(filePath)}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) {
        throw new Error('Could not load the review');
      }
      const body = (await response.json()) as Review;
      setReview(body);
      setContent(body.after ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the review');
    }
  }, [workspaceId, filePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/google/review/${decision}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(decision === 'approve' ? { filePath, content } : { filePath }),
        });
        const body = (await response.json()) as { outcome?: string; detail?: string; error?: string };

        if (body.outcome === 'stale') {
          // The server has already rebuilt the proposal against the newer state.
          setError('Something changed while you were reviewing. The proposal below has been refreshed.');
          await load();
          return;
        }
        if (!response.ok) {
          throw new Error(body.detail || body.error || `Could not ${decision} the change`);
        }

        onApplied();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Could not ${decision} the change`);
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, filePath, content, load, onApplied, onClose],
  );

  const rebaseline = useCallback(async () => {
    if (!window.confirm('Replace the Google Doc with the GitHub version? Anything written in the Doc will be lost.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/google/rebaseline`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      const body = (await response.json()) as { detail?: string; error?: string };
      if (!response.ok) {
        throw new Error(body.detail || body.error || 'Could not republish');
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not republish');
    } finally {
      setBusy(false);
    }
  }, [workspaceId, filePath, onApplied, onClose]);

  if (!review) {
    return (
      <aside className="gdocs-review">
        <header className="gdocs-review-header">
          <strong>Google Docs edit</strong>
          <button type="button" className="doc-button doc-button-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="gdocs-review-note">{error ?? 'Loading…'}</p>
      </aside>
    );
  }

  if (review.status !== 'ready') {
    return (
      <aside className="gdocs-review">
        <header className="gdocs-review-header">
          <strong>Google Docs edit</strong>
          <button type="button" className="doc-button doc-button-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="gdocs-review-note">{STATUS_MESSAGE[review.status]}</p>
        {review.status === 'baseline-lost' && (
          <>
            <p className="gdocs-review-note">
              Republishing from GitHub rebuilds the comparison snapshot and gets syncing going again.{' '}
              <strong>Anything currently in the Google Doc will be replaced</strong>, so copy out whatever is worth
              keeping first.
            </p>
            <footer className="gdocs-review-actions">
              <button type="button" className="doc-button doc-button-ghost" onClick={rebaseline} disabled={busy}>
                Republish from GitHub
              </button>
            </footer>
          </>
        )}
      </aside>
    );
  }

  const diff = lineDiff(review.before ?? '', content);
  const conflicts = review.conflicts ?? [];

  return (
    <aside className="gdocs-review">
      <header className="gdocs-review-header">
        <strong>Google Docs edit</strong>
        <a href={review.docUrl} target="_blank" rel="noopener noreferrer" className="doc-button doc-button-ghost">
          Open Doc
        </a>
        <button type="button" className="doc-button doc-button-ghost" onClick={onClose}>
          Close
        </button>
      </header>

      <p className="gdocs-review-note">
        {review.editor ? `Edited by ${review.editor}.` : 'The editor could not be identified.'} Approving commits this
        to GitHub and republishes the replica; rejecting discards it and restores the replica.
      </p>

      {error && <p className="gdocs-review-error">{error}</p>}

      {conflicts.length > 0 && (
        <section className="gdocs-review-conflicts">
          <strong>
            {conflicts.length} part{conflicts.length === 1 ? '' : 's'} could not be applied automatically
          </strong>
          {conflicts.map((conflict) => (
            <div className="gdocs-review-conflict" key={`${conflict.reason}-${conflict.incoming.join('')}`}>
              <p>{CONFLICT_EXPLANATION[conflict.reason]}</p>
              <pre>{conflict.incoming.join('\n')}</pre>
            </div>
          ))}
          <p className="gdocs-review-note">Edit the proposal below to include anything worth keeping.</p>
        </section>
      )}

      {(review.newAssets?.length ?? 0) > 0 && (
        <p className="gdocs-review-note">
          {review.newAssets?.length} new image{review.newAssets?.length === 1 ? '' : 's'} will be committed alongside
          this change.
        </p>
      )}
      {(review.rejectedAssets?.length ?? 0) > 0 && (
        <p className="gdocs-review-note">
          {review.rejectedAssets?.length} image{review.rejectedAssets?.length === 1 ? ' was' : 's were'} dropped:{' '}
          {review.rejectedAssets?.map((asset) => asset.reason).join('; ')}.
        </p>
      )}

      <div className="history-diff gdocs-review-diff">
        {diff.length === 0 ? (
          <p className="gdocs-review-note">The proposal matches the repository exactly.</p>
        ) : (
          diff.map((line, index) => (
            <div
              // Diff lines have no identity of their own; position is what distinguishes them.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
              key={`${index}-${line.text}`}
              className={`diff-line ${line.type === 'add' ? 'diff-add' : 'diff-del'}`}
            >
              {line.text || ' '}
            </div>
          ))
        )}
      </div>

      <label className="gdocs-review-label" htmlFor="gdocs-review-content">
        Proposed document
      </label>
      <textarea
        id="gdocs-review-content"
        className="gdocs-review-editor"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        spellCheck={false}
      />

      <footer className="gdocs-review-actions">
        <button
          type="button"
          className="doc-button doc-button-primary"
          onClick={() => decide('approve')}
          disabled={busy}
        >
          Approve &amp; commit
        </button>
        <button type="button" className="doc-button doc-button-ghost" onClick={() => decide('reject')} disabled={busy}>
          Reject &amp; restore replica
        </button>
      </footer>
    </aside>
  );
}
