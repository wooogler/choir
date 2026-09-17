/**
 * Google Picker plumbing, shared by the two places that need a document chosen:
 * linking an existing document to a replica, and importing one into the
 * repository.
 *
 * The Picker is loaded on demand from Google's script host; it is not bundled.
 * Its own typings are not published, so this is the minimum surface we use.
 *
 * Not a component, so it has no context to read: the caller passes its bound
 * translator in. That is the smaller change of the two options — the
 * alternative, returning error codes for the caller to translate, would mean a
 * second switch at each of the two call sites for no extra flexibility.
 */

import { type ServerErrorPayload, type T, describeServerError } from '../i18n';

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
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string; NAME: string };
};

declare global {
  interface Window {
    gapi?: { load: (name: string, callback: () => void) => void };
    google?: { picker: PickerNamespace };
  }
}

type PickerBootstrap = {
  accessToken: string;
  apiKey: string;
  appId: string;
  pickerNonce: string;
};

export interface PickedDocument {
  fileId: string;
  /** The Doc's title, used to suggest a repository filename on import. */
  name: string;
  /** Proves to the server that this fileId came from a deliberate pick. */
  pickerNonce: string;
}

let pickerScriptPromise: Promise<void> | null = null;

/** Loads Google's picker bundle once per page, whoever asks first. */
function loadPicker(t: T): Promise<void> {
  if (pickerScriptPromise) return pickerScriptPromise;

  pickerScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-choir-gapi]');
    const onLoad = () => {
      if (!window.gapi) {
        reject(new Error(t('picker.error.gapiMissing')));
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
      reject(new Error(t('picker.error.scriptFailed')));
    };
    document.head.appendChild(script);
  });

  return pickerScriptPromise;
}

/**
 * Opens the Picker and resolves with the chosen document, or null if it was
 * dismissed. The access token is minted per call by the server and never stored
 * in the browser.
 */
export async function pickGoogleDoc(workspaceId: string, t: T): Promise<PickedDocument | null> {
  const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/google/picker-token`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  const bootstrap = (await response.json()) as PickerBootstrap & ServerErrorPayload;
  if (!response.ok) {
    throw new Error(describeServerError(t, bootstrap) ?? t('picker.error.start'));
  }

  await loadPicker(t);
  const picker = window.google?.picker;
  if (!picker) throw new Error(t('picker.error.unavailable'));

  const view = new picker.DocsView(picker.ViewId.DOCUMENTS);
  view.setMimeTypes('application/vnd.google-apps.document');
  view.setIncludeFolders(false);

  return new Promise<PickedDocument | null>((resolve) => {
    new picker.PickerBuilder()
      // appId must be the Cloud project number matching the OAuth client, or the
      // per-file grant never attaches to this app and the picked document stays
      // unreachable from the server.
      .setAppId(bootstrap.appId)
      .setOAuthToken(bootstrap.accessToken)
      .setDeveloperKey(bootstrap.apiKey)
      .addView(view)
      .setCallback((data: PickerCallbackData) => {
        const action = data[picker.Response.ACTION];
        if (action === picker.Action.CANCEL) {
          resolve(null);
          return;
        }
        if (action !== picker.Action.PICKED) return;

        const documents = data[picker.Response.DOCUMENTS] as Array<Record<string, string>> | undefined;
        const chosen = documents?.[0];
        const fileId = chosen?.[picker.Document.ID];
        if (!fileId) {
          resolve(null);
          return;
        }
        resolve({ fileId, name: chosen?.[picker.Document.NAME] || '', pickerNonce: bootstrap.pickerNonce });
      })
      .build()
      .setVisible(true);
  });
}
