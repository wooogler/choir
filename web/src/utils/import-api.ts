/**
 * The viewer's client for the import endpoints (`/api/docs/:ws/import/…`).
 *
 * One module rather than three fetch calls scattered through the components,
 * because every import request shares the same two awkward jobs: reading an
 * NDJSON stream that reports progress and ends in a result, and turning a
 * refusal into something `describeServerError` can say in the reader's
 * language. The components are left with state and markup.
 *
 * The draft asset rewriting at the bottom is here for the same reason it is
 * pure: the preview editor shows images that only exist in a server-side draft,
 * so the markdown it is handed and the markdown it hands back are not the same
 * text, and that translation is worth being able to read (and test) on its own.
 *
 * See docs/pdf-web-import.md.
 */

import type { ServerErrorPayload, T } from '../i18n';
import { ApiError, describeApiError, errorPayload } from './api-error';
import { encodePath } from './docs';
import { readNdjson } from './ndjson';

export const IMPORT_STREAM_TYPE = 'application/x-ndjson';

/** Steps a conversion walks through; the commit stream has its own list. */
export type ImportConvertStep = 'checking' | 'fetching' | 'converting' | 'ready';
export type ImportCommitStep = 'checking' | 'committing' | 'mirroring' | 'indexing' | 'done';

/**
 * One progress line. `step` is typed as a plain string on purpose: a server
 * newer than this bundle may stream a step the catalog has no word for, and the
 * English `label` beside it is a better answer there than a blank bar.
 */
export interface ImportProgress {
  step: string;
  index: number;
  total: number;
  label: string;
  /** Progress *within* a step — PDF chunk 2 of 5. */
  chunk?: { current: number; total: number };
}

export type ImportProgressHandler = (progress: ImportProgress) => void;

export interface ImportStatus {
  canImport: boolean;
  pdf: { maxBytes: number; maxPages: number; llm: boolean };
}

export type ImportWarningCode =
  | 'low_fidelity'
  | 'scanned_pages'
  | 'readability_fallback'
  | 'images_rejected'
  | 'truncated';

export interface ImportWarning {
  /** A known `ImportWarningCode`, or anything a newer server invents. */
  code: string;
  detail?: Record<string, string | number>;
}

export interface ImportRejectedAsset {
  reason: string;
  contentType: string;
  bytes: number;
}

export interface ImportSourceInfo {
  /** `google-docs` and `meeting` share the draft pipeline, so they share this shape. */
  kind: 'pdf' | 'url' | 'google-docs' | 'meeting';
  name: string;
  url?: string;
  pages?: number;
  /** A meeting's size: how long it ran and how many people spoke. */
  minutes?: number;
  speakers?: number;
}

/** What a conversion produces: a draft held on the server, not a document yet. */
export interface DraftResult {
  draftId: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  markdown: string;
  title: string;
  suggestedPath: string;
  warnings: ImportWarning[];
  assets: Array<{ path: string; bytes: number; contentType: string }>;
  rejectedAssets: ImportRejectedAsset[];
  source: ImportSourceInfo;
}

/** The pre-flight a PDF upload answers with, before any model is called. */
export interface PdfEstimate {
  pages: number;
  scannedPages: number;
  chunks: number;
  inputTokens: number;
  estimatedOutputTokens: number;
  /** Absent when the workspace's model has no price we know. */
  estimatedUsd?: number;
  model: string;
  serviceTier: string;
  maxInputTokens: number;
}

export interface PdfUpload {
  uploadId: string;
  filename: string;
  expiresAt: number;
  estimate: PdfEstimate;
}

/**
 * A glossary row travelling with a commit: the manager ticked a term the
 * conversion did not recognise. `aliases` and `description` are optional
 * because ticking a term and writing nothing is the ordinary case.
 */
export interface ImportGlossaryRow {
  term: string;
  aliases?: string[];
  description?: string;
}

/** What `/import/commit` accepts beside the document (`glossary`). */
export interface ImportGlossaryRequest {
  rows: ImportGlossaryRow[];
  /** Basename of the glossary; the server's default unless this says otherwise. */
  fileName?: string;
  /** `folder` forces a new glossary beside the document even if a parent has one. */
  createAt?: 'nearest' | 'folder';
}

/** Where the rows landed. Absent rows — or none of them new — answer `null`. */
export interface ImportGlossaryCommit {
  path: string;
  added: number;
  /** Terms the file already had, by name. */
  skipped: string[];
  created: boolean;
}

export interface ImportCommitResult {
  githubPath: string;
  commitSha: string;
  /** Image references the commit dropped because the draft did not hold them. */
  droppedReferences: string[];
  /**
   * The glossary half of the same commit, or `null` when nothing was asked for
   * or nothing was new. Optional so an older server's answer still parses.
   */
  glossary?: ImportGlossaryCommit | null;
}

/**
 * A refusal carrying the server's code, so the call site can hand it to
 * `describeServerError` rather than showing the server's English.
 */
export class ImportApiError extends ApiError {
  constructor(payload: ServerErrorPayload, status?: number) {
    super(payload, status);
    this.name = 'ImportApiError';
  }
}

/**
 * The sentence to show for a failed import call.
 *
 * Anything that is not an `ApiError` — a dropped connection, a parse failure —
 * gets the caller's fallback rather than its own English message: those strings
 * were written for a console, not for a reader.
 */
export function describeImportError(t: T, error: unknown, fallback: string): string {
  return describeApiError(t, error, fallback);
}

function importBase(workspaceId: string): string {
  return `/api/docs/${encodeURIComponent(workspaceId)}/import`;
}

async function failureFrom(response: Response): Promise<ImportApiError> {
  return new ImportApiError(await errorPayload(response), response.status);
}

type StreamEvent<TResult> =
  | ({ type: 'progress' } & ImportProgress)
  | ({ type: 'result' } & TResult)
  | ({ type: 'error'; status?: number } & ServerErrorPayload);

/**
 * Runs a request that streams NDJSON and returns the `result` line.
 *
 * The status line goes out before the first step runs, so a streaming endpoint
 * reports its outcome on the last line instead of in the status — and a
 * response that ends without one is an interruption, not a success.
 *
 * Exported for `meeting-api.ts`, whose conversion streams the same lines from
 * a route of its own: one reader for every NDJSON endpoint the viewer calls.
 */
export async function requestStream<TResult>(
  url: string,
  init: RequestInit,
  onProgress?: ImportProgressHandler,
): Promise<TResult> {
  const streamable = typeof ReadableStream === 'function';
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init.headers ?? {}), Accept: streamable ? IMPORT_STREAM_TYPE : 'application/json' },
  });

  const body = response.body;
  const streamed = Boolean(body) && (response.headers.get('Content-Type') ?? '').includes(IMPORT_STREAM_TYPE);
  if (!streamed || !body) {
    if (!response.ok) throw await failureFrom(response);
    return (await response.json()) as TResult;
  }

  let result: TResult | null = null;
  for await (const event of readNdjson<StreamEvent<TResult>>(body)) {
    if (event.type === 'progress') {
      onProgress?.({
        step: event.step,
        index: event.index,
        total: event.total,
        label: event.label,
        chunk: event.chunk,
      });
    } else if (event.type === 'error') {
      throw new ImportApiError(event, event.status ?? response.status);
    } else if (event.type === 'result') {
      result = event;
    }
  }
  if (!result) throw new ImportApiError({ error: 'import_interrupted' });
  return result;
}

/**
 * Whether this person may import here at all, and the PDF limits to check
 * before uploading anything. A failure is a "no": the menu stays hidden rather
 * than offering a button every press of which would 403.
 */
export async function fetchImportStatus(workspaceId: string): Promise<ImportStatus | null> {
  try {
    const response = await fetch(`${importBase(workspaceId)}/status`, { credentials: 'same-origin' });
    if (!response.ok) return null;
    return (await response.json()) as ImportStatus;
  } catch {
    return null;
  }
}

export function convertUrl(workspaceId: string, url: string, onProgress?: ImportProgressHandler): Promise<DraftResult> {
  return requestStream<DraftResult>(
    `${importBase(workspaceId)}/url`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) },
    onProgress,
  );
}

/**
 * Uploads the PDF and gets the estimate back. No model has been called yet:
 * this is the number a manager confirms before the workspace's key is billed.
 */
export async function uploadPdf(workspaceId: string, file: File): Promise<PdfUpload> {
  const response = await fetch(`${importBase(workspaceId)}/pdf`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/pdf',
      // Encoded because a filename may hold anything a filesystem allows, and a
      // header may not.
      'X-Import-Filename': encodeURIComponent(file.name),
    },
    body: file,
  });
  if (!response.ok) throw await failureFrom(response);
  return (await response.json()) as PdfUpload;
}

export function convertPdf(
  workspaceId: string,
  uploadId: string,
  onProgress?: ImportProgressHandler,
): Promise<DraftResult> {
  return requestStream<DraftResult>(
    `${importBase(workspaceId)}/pdf/${encodeURIComponent(uploadId)}/convert`,
    { method: 'POST' },
    onProgress,
  );
}

/**
 * Lands the draft as a document. `glossary`, when present, is committed in the
 * same commit (docs/meeting-notes-and-glossary.md, 용어집 §5) — one commit for
 * the note and the terms it taught us.
 */
export function commitDraft(
  workspaceId: string,
  body: { draftId: string; filePath: string; markdown: string; glossary?: ImportGlossaryRequest },
  onProgress?: ImportProgressHandler,
): Promise<ImportCommitResult> {
  return requestStream<ImportCommitResult>(
    `${importBase(workspaceId)}/commit`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    onProgress,
  );
}

/**
 * Drops a draft the manager walked away from. Failures are ignored on purpose:
 * the draft expires by itself, and there is nothing useful to say about a
 * cleanup the person did not ask for.
 */
export function discardDraft(workspaceId: string, draftId: string): void {
  void fetch(`${importBase(workspaceId)}/draft/${encodeURIComponent(draftId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  }).catch(() => {});
}

// ── Draft images ────────────────────────────────────────────────────────────
//
// A draft's images are not in the repository yet, so `assets/<hash>.png` — the
// path that will be correct once the document is committed — resolves to
// nothing while the preview is open. The preview therefore shows them through
// the draft endpoint and puts the repository paths back before committing.
//
// The URL is absolute (origin included) so that CrepeEditor's `proxyDomURL`
// passes it through untouched: it treats anything that is not an absolute URL
// as a repo-relative asset and rewrites it against the document's folder.

const ASSET_IN_MARKDOWN = /(!?\[[^\]]*\]\(\s*<?)((?:\.\/|\/)?assets\/[^\s)>]+)/g;
const ASSET_IN_HTML = /((?:src|href)\s*=\s*["'])((?:\.\/|\/)?assets\/[^"']+)/gi;

function origin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** Where a draft's images are served from, with the trailing slash. */
export function draftAssetBase(workspaceId: string, draftId: string): string {
  return `${origin()}/api/docs/${encodeURIComponent(workspaceId)}/import/draft/${encodeURIComponent(draftId)}/asset/`;
}

export function draftAssetUrl(workspaceId: string, draftId: string, assetPath: string): string {
  return `${draftAssetBase(workspaceId, draftId)}${encodePath(normalizeAssetPath(assetPath))}`;
}

/** `./assets/x.png`, `/assets/x.png` and `assets/x.png` are all the same file. */
function normalizeAssetPath(reference: string): string {
  return reference.replace(/^\.?\//, '');
}

/**
 * Markdown as the preview editor should see it: every `assets/…` reference
 * pointing at the draft endpoint.
 */
export function rewriteAssetUrlsForPreview(markdown: string, workspaceId: string, draftId: string): string {
  const toUrl = (reference: string) => draftAssetUrl(workspaceId, draftId, reference);
  return markdown
    .replace(ASSET_IN_MARKDOWN, (_match, lead: string, reference: string) => `${lead}${toUrl(reference)}`)
    .replace(ASSET_IN_HTML, (_match, lead: string, reference: string) => `${lead}${toUrl(reference)}`);
}

/**
 * The inverse: markdown as it should be committed, with the draft URLs back to
 * the repository-relative paths the commit will write.
 *
 * Anything else the manager typed — including an ordinary external image — is
 * left alone, and the server drops `assets/…` references the draft does not
 * hold rather than trusting this.
 */
export function restoreAssetPaths(markdown: string, workspaceId: string, draftId: string): string {
  const base = draftAssetBase(workspaceId, draftId);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}([^\\s)>"'\\]]*)`, 'g');
  return markdown.replace(pattern, (_match, encoded: string) => decodePathSegments(encoded));
}

function decodePathSegments(encoded: string): string {
  return encoded
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}
