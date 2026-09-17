import { useCallback, useEffect, useState } from 'react';
import { fillNodes, useT } from '../i18n';
import type { T } from '../i18n';
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

// The server's own codes, mapped to catalog keys. Keeping the map keyed by code
// is what made this component easy to translate: the text was already separated
// from the branch that chose it.
const CONFLICT_KEY = {
  'code-block': 'gdocs.review.conflict.codeBlock',
  unmappable: 'gdocs.review.conflict.unmappable',
  merge: 'gdocs.review.conflict.merge',
} as const satisfies Record<Conflict['reason'], Parameters<T>[0]>;

const STATUS_KEY = {
  'no-change': 'gdocs.review.status.noChange',
  'not-linked': 'gdocs.review.status.notLinked',
  'not-connected': 'gdocs.review.status.notConnected',
  'not-drifted': 'gdocs.review.status.notDrifted',
  'baseline-lost': 'gdocs.review.status.baselineLost',
} as const satisfies Record<Exclude<Review['status'], 'ready'>, Parameters<T>[0]>;

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
  const t = useT();
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
        throw new Error(t('gdocs.review.error.load'));
      }
      const body = (await response.json()) as Review;
      setReview(body);
      setContent(body.after ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('gdocs.review.error.load'));
    }
  }, [workspaceId, filePath, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      // Declared outside the try so the catch can reach it.
      const failure = decision === 'approve' ? 'gdocs.review.error.approve' : 'gdocs.review.error.reject';
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
          setError(t('gdocs.review.error.stale'));
          await load();
          return;
        }
        if (!response.ok) {
          // TODO(i18n): server error codes — `body.detail`/`body.error` are the API's own English text.
          throw new Error(body.detail || body.error || t(failure));
        }

        onApplied();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : t(failure));
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, filePath, content, load, onApplied, onClose, t],
  );

  const rebaseline = useCallback(async () => {
    if (!window.confirm(t('gdocs.review.confirm.rebaseline'))) {
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
        // TODO(i18n): server error codes — `body.detail`/`body.error` are the API's own English text.
        throw new Error(body.detail || body.error || t('gdocs.review.error.republish'));
      }
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('gdocs.review.error.republish'));
    } finally {
      setBusy(false);
    }
  }, [workspaceId, filePath, onApplied, onClose, t]);

  if (!review) {
    return (
      <aside className="gdocs-review">
        <header className="gdocs-review-header">
          <strong>{t('gdocs.review.heading')}</strong>
          <button type="button" className="doc-button doc-button-ghost" onClick={onClose}>
            {t('common.button.close')}
          </button>
        </header>
        <p className="gdocs-review-note">{error ?? t('common.loading')}</p>
      </aside>
    );
  }

  if (review.status !== 'ready') {
    return (
      <aside className="gdocs-review">
        <header className="gdocs-review-header">
          <strong>{t('gdocs.review.heading')}</strong>
          <button type="button" className="doc-button doc-button-ghost" onClick={onClose}>
            {t('common.button.close')}
          </button>
        </header>
        <p className="gdocs-review-note">{t(STATUS_KEY[review.status])}</p>
        {review.status === 'baseline-lost' && (
          <>
            <p className="gdocs-review-note">
              {fillNodes(t('gdocs.review.baselineLost.help'), {
                warning: <strong>{t('gdocs.review.baselineLost.warning')}</strong>,
              })}
            </p>
            <footer className="gdocs-review-actions">
              <button type="button" className="doc-button doc-button-ghost" onClick={rebaseline} disabled={busy}>
                {t('gdocs.review.button.republish')}
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
        <strong>{t('gdocs.review.heading')}</strong>
        <a href={review.docUrl} target="_blank" rel="noopener noreferrer" className="doc-button doc-button-ghost">
          {t('gdocs.review.button.openDoc')}
        </a>
        <button type="button" className="doc-button doc-button-ghost" onClick={onClose}>
          {t('common.button.close')}
        </button>
      </header>

      <p className="gdocs-review-note">
        {review.editor ? t('gdocs.review.editedBy', { editor: review.editor }) : t('gdocs.review.editorUnknown')}{' '}
        {t('gdocs.review.approveHint')}
      </p>

      {/* TODO(i18n): server error codes — a rejected decision can carry the API's own message. */}
      {error && <p className="gdocs-review-error">{error}</p>}

      {conflicts.length > 0 && (
        <section className="gdocs-review-conflicts">
          <strong>{t('gdocs.review.conflicts.count', { count: conflicts.length })}</strong>
          {conflicts.map((conflict) => (
            <div className="gdocs-review-conflict" key={`${conflict.reason}-${conflict.incoming.join('')}`}>
              <p>{t(CONFLICT_KEY[conflict.reason])}</p>
              <pre>{conflict.incoming.join('\n')}</pre>
            </div>
          ))}
          <p className="gdocs-review-note">{t('gdocs.review.conflicts.hint')}</p>
        </section>
      )}

      {(review.newAssets?.length ?? 0) > 0 && (
        <p className="gdocs-review-note">{t('gdocs.review.newAssets', { count: review.newAssets?.length ?? 0 })}</p>
      )}
      {(review.rejectedAssets?.length ?? 0) > 0 && (
        <p className="gdocs-review-note">
          {/* TODO(i18n): server error codes — each `reason` is the API's own English text. */}
          {t('gdocs.review.rejectedAssets', {
            count: review.rejectedAssets?.length ?? 0,
            reasons: review.rejectedAssets?.map((asset) => asset.reason).join('; ') ?? '',
          })}
        </p>
      )}

      <div className="history-diff gdocs-review-diff">
        {diff.length === 0 ? (
          <p className="gdocs-review-note">{t('gdocs.review.diff.identical')}</p>
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
        {t('gdocs.review.label.proposal')}
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
          {t('gdocs.review.button.approve')}
        </button>
        <button type="button" className="doc-button doc-button-ghost" onClick={() => decide('reject')} disabled={busy}>
          {t('gdocs.review.button.reject')}
        </button>
      </footer>
    </aside>
  );
}
