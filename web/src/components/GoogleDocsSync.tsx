import { useCallback, useEffect, useState } from 'react';
import { pickGoogleDoc } from '../utils/picker';

/**
 * Header control for linking a document to a Google Docs replica.
 *
 * The replica is one-way: GitHub is the source of truth and edits made in Google
 * Docs are not applied directly — they are collected and sent to a manager for
 * review. That is why linking is manager-only and why the confirmation below
 * spells out that the picked document's content will be replaced.
 *
 * Linking here always produces a `replica`, which is what the warning is about.
 * A document that must keep its own formatting arrives through the import
 * control instead, and this panel then only reports on it.
 */

type GoogleStatus = {
  configured: boolean;
  connected: boolean;
  email?: string;
  broken: boolean;
  document: {
    fileId: string;
    webViewLink: string;
    status?: string;
    /** 'preserve' documents are never written by CHOIR; see the import flow. */
    mode?: 'replica' | 'preserve';
    /** A GitHub change is waiting for a person to apply it in Google Docs. */
    awaitingManualApply?: boolean;
  } | null;
  linkedCount: number;
};

const REPLACE_WARNING =
  'The content of the Google Doc you pick will be replaced by this document, and kept in sync from GitHub. Continue?';

export function GoogleDocsSync({
  workspaceId,
  filePath,
  isManager,
  onReview,
}: {
  workspaceId: string;
  filePath: string;
  isManager: boolean;
  /** Opens the review panel; absent for people who cannot decide. */
  onReview?: () => void;
}) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/docs/${encodeURIComponent(workspaceId)}/google/status?filePath=${encodeURIComponent(filePath)}`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) {
        setStatus(null);
        return;
      }
      setStatus((await response.json()) as GoogleStatus);
    } catch {
      setStatus(null);
    }
  }, [workspaceId, filePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = () => {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.href = `/docs/auth/google/start?workspaceId=${encodeURIComponent(
      workspaceId,
    )}&next=${encodeURIComponent(next)}`;
  };

  const link = useCallback(
    async (fileId: string, pickerNonce: string) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/google/link`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filePath, fileId, pickerNonce }),
        });
        const body = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(body.error || 'Could not link the document');
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not link the document');
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, filePath, refresh],
  );

  const pick = useCallback(async () => {
    if (!window.confirm(REPLACE_WARNING)) return;

    setBusy(true);
    setError(null);
    try {
      const picked = await pickGoogleDoc(workspaceId);
      if (picked) void link(picked.fileId, picked.pickerNonce);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the file picker');
    } finally {
      setBusy(false);
    }
  }, [workspaceId, link]);

  const unlink = useCallback(async () => {
    if (!window.confirm('Stop syncing this document to Google Docs? The Google Doc itself is kept.')) return;

    setBusy(true);
    setError(null);
    try {
      await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/google/link`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlink the document');
    } finally {
      setBusy(false);
    }
  }, [workspaceId, filePath, refresh]);

  // Stay invisible unless the server offers the feature: a workspace without
  // Google credentials configured should see no trace of it.
  if (!status?.configured) return null;

  if (status.document) {
    // baseline-lost is frozen rather than pending, but it is the same panel that
    // offers the way out of it.
    const awaitingReview =
      status.document.status === 'drifted' ||
      status.document.status === 'pending-review' ||
      status.document.status === 'applying' ||
      status.document.status === 'baseline-lost';

    return (
      <span className="doc-gdocs">
        {awaitingReview && onReview && (
          <button type="button" className="doc-button doc-button-primary" onClick={onReview}>
            {status.document.status === 'baseline-lost' ? 'Fix Docs sync' : 'Review Docs edit'}
          </button>
        )}
        <a
          className="doc-button doc-button-ghost"
          href={status.document.webViewLink}
          target="_blank"
          rel="noopener noreferrer"
          title={
            status.document.awaitingManualApply
              ? 'This document keeps its own formatting, so a change from CHOIR is waiting for someone to apply it in Google Docs'
              : status.document.status === 'drifted' || status.document.status === 'pending-review'
                ? 'Someone edited the Google Doc; a manager is reviewing the change'
                : status.document.mode === 'preserve'
                  ? 'Open the Google Doc. CHOIR does not write to this one'
                  : 'Open the Google Docs replica'
          }
        >
          Google Doc
          {status.document.awaitingManualApply ||
          status.document.status === 'drifted' ||
          status.document.status === 'pending-review'
            ? ' •'
            : ''}
        </a>
        {isManager && (
          <button type="button" className="doc-button doc-button-ghost" onClick={unlink} disabled={busy}>
            Unlink
          </button>
        )}
      </span>
    );
  }

  if (!isManager) return null;

  return (
    <span className="doc-gdocs">
      <button
        type="button"
        className="doc-button doc-button-ghost"
        onClick={status.connected && !status.broken ? pick : connect}
        disabled={busy}
        title={
          status.broken
            ? 'The Google connection expired — reconnect to resume syncing'
            : 'Publish this document as a Google Doc, kept in sync from GitHub'
        }
      >
        {busy ? 'Working…' : status.broken ? 'Reconnect Google' : 'Sync to Google Docs'}
      </button>
      {error && (
        <span className="doc-change-count" title={error}>
          {error}
        </span>
      )}
    </span>
  );
}
