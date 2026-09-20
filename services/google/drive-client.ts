import { drive as driveClient } from '@googleapis/drive';
import { Logger } from 'services/common/logger';
import type { OAuth2Client } from './google-auth-service';

/**
 * The Drive operations the replica sync needs, with retries and the field sets
 * the design depends on.
 *
 * Content is uploaded as `text/markdown` against a target mimeType of
 * `application/vnd.google-apps.document`, which asks Drive to convert on the way
 * in. Measured against the HTML import path, markdown wins on lists,
 * blockquotes, rules and heading cleanliness and loses only on code blocks; see
 * scripts/spike-gdocs/README.md.
 */

const DOC_MIME = 'application/vnd.google-apps.document';
const MARKDOWN_MIME = 'text/markdown';
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;

export interface DocMeta {
  fileId: string;
  name?: string;
  /**
   * Monotonic counter that changes on every server-side change, content or
   * metadata. Native Google Docs have no `headRevisionId`, so this is the only
   * cheap change signal — and because metadata alone bumps it (measured: a rename
   * does), it is a trigger, never proof that a human edited the text.
   */
  version?: string;
  modifiedTime?: string;
  /** Only populated when the last writer was a signed-in user. Display only. */
  lastModifyingUser?: string;
  trashed?: boolean;
  webViewLink?: string;
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number; code?: number })?.status ?? (error as { code?: number })?.code;
}

/** Rate limits and transient server faults are worth retrying; nothing else is. */
function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS) {
        throw error;
      }
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      Logger.warn(`Drive ${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${delay}ms`, {
        status: statusOf(error),
      });
      await sleep(delay);
    }
  }

  throw lastError;
}

function client(auth: OAuth2Client) {
  return driveClient({ version: 'v3', auth });
}

function toMeta(
  fileId: string,
  data: {
    name?: string | null;
    version?: string | null;
    modifiedTime?: string | null;
    lastModifyingUser?: { emailAddress?: string | null; displayName?: string | null } | null;
    trashed?: boolean | null;
    webViewLink?: string | null;
  },
): DocMeta {
  return {
    fileId,
    name: data.name ?? undefined,
    version: data.version ?? undefined,
    modifiedTime: data.modifiedTime ?? undefined,
    lastModifyingUser: data.lastModifyingUser?.emailAddress ?? data.lastModifyingUser?.displayName ?? undefined,
    trashed: data.trashed ?? undefined,
    webViewLink: data.webViewLink ?? undefined,
  };
}

export async function createDocFromMarkdown(
  auth: OAuth2Client,
  params: { name: string; markdown: string; parentFolderId?: string },
): Promise<DocMeta> {
  return withRetry('files.create', async () => {
    const created = await client(auth).files.create({
      requestBody: {
        name: params.name,
        mimeType: DOC_MIME,
        parents: params.parentFolderId ? [params.parentFolderId] : undefined,
      },
      media: { mimeType: MARKDOWN_MIME, body: params.markdown },
      fields: 'id, name, version, modifiedTime, webViewLink',
    });
    if (!created.data.id) {
      throw new Error('Drive created a document without returning an id');
    }
    return toMeta(created.data.id, created.data);
  });
}

/**
 * Lets anyone holding the link read the document. Reader only: a replica's edits
 * go through review, and an editor grant would invite people to type into a
 * document whose text CHOIR replaces on the next GitHub change.
 *
 * Confirmed in the P0 spike (check 8) as within `drive.file` for app-created
 * files.
 */
export async function shareByLink(auth: OAuth2Client, fileId: string): Promise<void> {
  await withRetry('permissions.create', async () => {
    await client(auth).permissions.create({
      fileId,
      requestBody: { type: 'anyone', role: 'reader' },
    });
  });
}

/**
 * Replaces a document's entire content, keeping its fileId and URL — verified in
 * the P0 spike, and the reason replica links stay stable across syncs.
 *
 * Returns the `version` from the update response itself. The publisher fences on
 * it: a human edit landing between this write and the export taken from it would
 * otherwise be baked into the baseline and never reported as drift.
 */
export async function replaceDocContent(auth: OAuth2Client, fileId: string, markdown: string): Promise<DocMeta> {
  return withRetry('files.update', async () => {
    const updated = await client(auth).files.update({
      fileId,
      media: { mimeType: MARKDOWN_MIME, body: markdown },
      fields: 'id, name, version, modifiedTime, webViewLink',
    });
    return toMeta(fileId, updated.data);
  });
}

/**
 * Sets the file's Drive `description` and nothing else.
 *
 * The metadata counterpart to `replaceDocContent`: no `media`, so the body is
 * untouched. This is how a document CHOIR must not rewrite carries the notice
 * that it is linked — the banner cannot be used there, because the banner is
 * body text and would be the one thing CHOIR ever wrote into it.
 *
 * It still bumps `version` (measured: metadata alone does), so callers that are
 * about to record a version must stamp first and read after.
 */
export async function setDocDescription(auth: OAuth2Client, fileId: string, description: string): Promise<DocMeta> {
  return withRetry('files.update(description)', async () => {
    const updated = await client(auth).files.update({
      fileId,
      requestBody: { description },
      fields: 'id, name, version, modifiedTime, webViewLink',
    });
    return toMeta(fileId, updated.data);
  });
}

export async function exportDocMarkdown(auth: OAuth2Client, fileId: string): Promise<string> {
  return withRetry('files.export', async () => {
    const response = await client(auth).files.export({ fileId, mimeType: MARKDOWN_MIME }, { responseType: 'text' });
    const data = response.data as unknown;
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf-8');
    return String(data ?? '');
  });
}

export async function getDocMeta(auth: OAuth2Client, fileId: string): Promise<DocMeta> {
  return withRetry('files.get', async () => {
    const response = await client(auth).files.get({
      fileId,
      fields: 'id, name, version, modifiedTime, lastModifyingUser(emailAddress, displayName), trashed, webViewLink',
    });
    return toMeta(fileId, response.data);
  });
}

export async function createFolder(auth: OAuth2Client, name: string, parentFolderId?: string): Promise<string> {
  return withRetry('files.create(folder)', async () => {
    const created = await client(auth).files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentFolderId ? [parentFolderId] : undefined,
      },
      fields: 'id',
    });
    if (!created.data.id) {
      throw new Error('Drive created a folder without returning an id');
    }
    return created.data.id;
  });
}
