import { useCallback, useEffect, useState } from 'react';

/**
 * Header control for linking a document to a Google Docs replica.
 *
 * The replica is one-way: GitHub is the source of truth and edits made in Google
 * Docs are not applied directly — they are collected and sent to a manager for
 * review. That is why linking is manager-only and why the confirmation below
 * spells out that the picked document's content will be replaced.
 */

type GoogleStatus = {
  configured: boolean;
  connected: boolean;
  email?: string;
  broken: boolean;
  document: { fileId: string; webViewLink: string; status?: string } | null;
  linkedCount: number;
};

type PickerBootstrap = {
  accessToken: string;
  apiKey: string;
  appId: string;
  pickerNonce: string;
};

// The Picker is loaded on demand from Google's script host; it is not bundled.
// Its own typings are not published, so this is the minimum surface we use.
type PickerDocsView = {
  setMimeTypes: (types: string) => unknown;
  setIncludeFolders: (include: boolean) => unknown;
};

/** Keys are the picker's own response constants, so values arrive untyped. */
type PickerCallbackData = Record<string, unknown>;

type PickerBuilderInstance = {
  setAppId: (appId: string) => PickerBuilderInstance;
  setOAuthToken: (token: string) => PickerBuilderInstance;
  setDeveloperKey: (key: string) => PickerBuilderInstance;
  addView: (view: PickerDocsView) => PickerBuilderInstance;
  setCallback: (callback: (data: PickerCallbackData) => void) => PickerBuilderInstance;
  build: () => { setVisible: (visible: boolean) => void };
};

type PickerNamespace = {
  DocsView: new (viewId: unknown) => PickerDocsView;
  PickerBuilder: new () => PickerBuilderInstance;
  ViewId: { DOCUMENTS: unknown };
  Action: { PICKED: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string };
};

declare global {
  interface Window {
    gapi?: { load: (name: string, callback: () => void) => void };
    google?: { picker: PickerNamespace };
  }
}

let pickerScriptPromise: Promise<void> | null = null;

/** Loads Google's picker bundle once per page, whoever asks first. */
function loadPicker(): Promise<void> {
  if (pickerScriptPromise) return pickerScriptPromise;

  pickerScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-choir-gapi]');
    const onLoad = () => {
      if (!window.gapi) {
        reject(new Error('Google API script loaded without gapi'));
        return;
      }
      window.gapi.load('picker', () => resolve());
    };

    if (existing) {
      onLoad();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    script.dataset.choirGapi = 'true';
    script.onload = onLoad;
    script.onerror = () => {
      // Let a later attempt retry rather than caching the failure forever.
      pickerScriptPromise = null;
      reject(new Error('Could not load the Google file picker'));
    };
    document.head.appendChild(script);
  });

  return pickerScriptPromise;
}

const REPLACE_WARNING =
  'The content of the Google Doc you pick will be replaced by this document, and kept in sync from GitHub. Continue?';

export function GoogleDocsSync({
  workspaceId,
  filePath,
  isManager,
}: {
  workspaceId: string;
  filePath: string;
  isManager: boolean;
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
      const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/google/picker-token`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const bootstrap = (await response.json()) as PickerBootstrap & { error?: string };
      if (!response.ok) {
        throw new Error(bootstrap.error || 'Could not start the file picker');
      }

      await loadPicker();
      const picker = window.google?.picker;
      if (!picker) throw new Error('The Google file picker is unavailable');

      const view = new picker.DocsView(picker.ViewId.DOCUMENTS);
      view.setMimeTypes('application/vnd.google-apps.document');
      view.setIncludeFolders(false);

      new picker.PickerBuilder()
        // appId must be the Cloud project number matching the OAuth client, or
        // the per-file grant never attaches to this app and the picked document
        // stays unreachable from the server.
        .setAppId(bootstrap.appId)
        .setOAuthToken(bootstrap.accessToken)
        .setDeveloperKey(bootstrap.apiKey)
        .addView(view)
        .setCallback((data: PickerCallbackData) => {
          if (data[picker.Response.ACTION] !== picker.Action.PICKED) return;
          const documents = data[picker.Response.DOCUMENTS] as Array<Record<string, string>> | undefined;
          const fileId = documents?.[0]?.[picker.Document.ID];
          if (fileId) void link(fileId, bootstrap.pickerNonce);
        })
        .build()
        .setVisible(true);
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
    return (
      <span className="doc-gdocs">
        <a
          className="doc-button doc-button-ghost"
          href={status.document.webViewLink}
          target="_blank"
          rel="noopener noreferrer"
          title={
            status.document.status === 'drifted' || status.document.status === 'pending-review'
              ? 'Someone edited the Google Doc; a manager is reviewing the change'
              : 'Open the Google Docs replica'
          }
        >
          Google Doc
          {status.document.status === 'drifted' || status.document.status === 'pending-review' ? ' •' : ''}
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
