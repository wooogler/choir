import path from 'node:path';
import {
  type DocsApiErrorCode,
  type DocsApiErrorDetail,
  apiError,
  apiErrorBodyFor,
  isDocsApiErrorCode,
  writeAccessErrorBody,
} from 'services/docs-editor/api-errors';
import { CreateDocumentRefusal, createDocument } from 'services/docs-editor/create-document';
import { getDocsWriteAccess } from 'services/docs-editor/write-access';
import { suggestImportPath } from 'services/google/import-path';
import { isOpenAIEnabled } from 'services/llm/llm-config';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { prepareCommit } from './commit-guard';
import { type CreatedDraft, getDraftStore } from './draft-store';
import { isImportBusy, runExclusiveImport } from './mutex';
import { type ImportStepProgress, makeCommitReporter, makeConvertReporter } from './progress';
import { buildSourceNote, pickDocumentLanguage, prependSourceNote } from './source-note';
import { loadPdfImportConfig } from './sources/pdf/config';
import type { ConvertedDocument, ImportSourceInfo } from './types';
import { ImportRefusal } from './types';
import { getUploadStore } from './upload-store';

/**
 * HTTP surface for importing a PDF or a public web page as a new document.
 *
 * Import is deliberately several calls rather than one (docs/pdf-web-import.md,
 * 결정 2): a conversion is lossy, so the manager reads and edits the markdown
 * before it becomes a commit. That shape is what everything below serves —
 * convert into a draft, preview it, then commit the draft — with the PDF path
 * carrying one extra step, an estimate, because that conversion is billed to the
 * workspace's own OpenAI key and nobody should be charged by surprise.
 *
 * Registered from app.ts, which owns session reading, the body parsers and
 * express itself, so those arrive as dependencies rather than being
 * re-implemented here.
 *
 * IMPORTANT: these must be registered before `/api/docs/:workspaceId/*splat`,
 * which would otherwise swallow every `/api/docs/<id>/import/...` path.
 */

export interface ImportRouteDeps {
  readSession: (req: unknown) => Promise<{ workspaceId: string; userId: string } | null>;
  isManager: (workspaceId: string, userId: string) => Promise<boolean>;
  /** `express.json(...)`, for the two routes with a JSON body. */
  jsonBody: unknown;
  /** `express.raw({ type: 'application/pdf', limit })` — see {@link pdfUploadLimitBytes}. */
  rawPdfBody: unknown;
  logger: {
    info: (m: string, meta?: unknown) => void;
    warn: (m: string, meta?: unknown) => void;
    error: (m: string, e?: unknown) => void;
  };
}

/** Content type the conversion endpoints stream step-by-step progress as. */
const IMPORT_STREAM_TYPE = 'application/x-ndjson';

/** What an upload is called when the browser sent no usable `X-Import-Filename`. */
const DEFAULT_PDF_FILENAME = 'document.pdf';

const MEGABYTE = 1024 * 1024;

// Express's router and handlers are untyped throughout app.ts (the receiver
// exposes them as `any`); these aliases keep that contained to one place.
type Router = { get: Handler; post: Handler; delete: Handler };
type Handler = (path: string, ...rest: unknown[]) => void;
type Req = {
  params: Record<string, string | string[]>;
  query: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};
type Res = {
  status: (code: number) => Res;
  json: (body: unknown) => Res;
  send: (body: unknown) => Res;
  setHeader: (name: string, value: string | string[]) => void;
  /** Used by the streaming conversions, which report progress line by line. */
  write: (chunk: string) => boolean;
  end: (chunk?: string) => void;
  flushHeaders?: () => void;
  headersSent?: boolean;
};

type Session = { workspaceId: string; userId: string };

/**
 * The `express.raw` limit the PDF route must be registered with.
 *
 * app.ts builds the middleware because it owns express, but the number is the
 * import's: a limit larger than `IMPORT_PDF_MAX_BYTES` would let a body through
 * that the inspection refuses a moment later, after the whole upload was read.
 */
export function pdfUploadLimitBytes(): number {
  return loadPdfImportConfig().maxBytes;
}

export function registerImportRoutes(router: Router, deps: ImportRouteDeps): void {
  /**
   * The ladder every route below the status endpoint climbs.
   *
   * Session, then workspace, then CHOIR manager, then GitHub push access — the
   * same four the "New document" route makes, and for the same reason: an import
   * ends in a commit, so a manager whose GitHub account cannot push must be told
   * that before converting a 40-page PDF on the workspace's key rather than
   * after.
   */
  const requireImporter = async (req: Req, res: Res, workspaceId: string): Promise<Session | null> => {
    const session = await deps.readSession(req);
    if (!session) {
      apiError(res, 401, 'not_signed_in');
      return null;
    }
    if (session.workspaceId !== workspaceId) {
      apiError(res, 403, 'workspace_mismatch');
      return null;
    }
    if (!(await deps.isManager(workspaceId, session.userId))) {
      apiError(res, 403, 'not_a_manager');
      return null;
    }

    const writeAccess = await getDocsWriteAccess(workspaceId, session.userId);
    if (!writeAccess.canPush) {
      res.status(403).json(writeAccessErrorBody(writeAccess.reason, writeAccess.detail));
      return null;
    }

    return session;
  };

  // ── What this workspace can import ───────────────────────────────────────

  /**
   * Whether to offer import at all, and the limits to enforce in the browser.
   *
   * Every refusal reason is folded into one boolean on purpose: the viewer shows
   * or hides a menu item with it, and a reader who is not a manager has no use
   * for the difference between "not a manager" and "no push access". It never
   * throws — a failed probe is answered as "cannot import", because a menu item
   * that 500s is worse than one that is absent.
   */
  router.get('/api/docs/:workspaceId/import/status', async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const session = await deps.readSession(req);
      if (!session || session.workspaceId !== workspaceId) {
        return apiError(res, 401, 'unauthorized');
      }

      const config = loadPdfImportConfig();
      const canImport = await canImportHere(workspaceId, session.userId, deps);

      return res.json({
        canImport,
        pdf: {
          maxBytes: config.maxBytes,
          maxPages: config.maxPages,
          // `text` mode never calls the model, so the key does not matter there;
          // everywhere else, a workspace with no key gets the text fallback and
          // should be told before it uploads a scan that cannot be read at all.
          llm: config.mode !== 'text' && (await hasOpenAIKey(workspaceId)),
        },
      });
    } catch (err) {
      deps.logger.error('GET import/status failed', err);
      return apiError(res, 500, 'internal_error');
    }
  });

  // ── Convert ──────────────────────────────────────────────────────────────

  /**
   * A public URL in, a draft out. No model is involved (결정 5).
   */
  router.post('/api/docs/:workspaceId/import/url', deps.jsonBody, async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);
    let streaming = false;

    try {
      const session = await requireImporter(req, res, workspaceId);
      if (!session) return undefined;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const url = String(body.url ?? '').trim();
      if (!url) {
        return apiError(res, 400, 'import_url_invalid');
      }

      // Answered before the stream opens, so a busy workspace gets a real status
      // line rather than a 200 whose first and only line is an error.
      if (isImportBusy(workspaceId)) {
        return apiError(res, 409, 'import_busy');
      }

      streaming = beginStream(req, res);
      const onProgress = makeConvertReporter(streaming ? (progress) => writeProgress(res, progress) : undefined);

      const document = await runExclusiveImport(workspaceId, async () => {
        // Loaded here rather than at the top of the file: the web source pulls
        // in JSDOM, and a process that never imports a page should never pay for
        // it. Same for the PDF source and pdfjs below.
        const { convertUrl } = await import('./sources/web');
        return convertUrl(url, { onProgress });
      });

      const created = getDraftStore().create({ workspaceId, userId: session.userId, document });
      deps.logger.info('Converted a web page for import', { workspaceId, url, draftId: created.id });

      return finishWithDraft(res, streaming, created, document);
    } catch (err) {
      return failRequest(res, streaming, err, deps, 'POST import/url failed');
    }
  });

  /**
   * A PDF upload in, an estimate out. Nothing is sent to the model here — the
   * bytes are parked and the manager decides whether the price is worth it.
   */
  router.post('/api/docs/:workspaceId/import/pdf', deps.rawPdfBody, async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);

    try {
      const session = await requireImporter(req, res, workspaceId);
      if (!session) return undefined;

      // `express.raw` only fills `body` with a Buffer when the content type
      // matched, so anything else arriving here is not the PDF it claimed to be.
      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return apiError(res, 415, 'import_unsupported_file');
      }

      const config = loadPdfImportConfig();
      if (bytes.length > config.maxBytes) {
        return apiError(res, 413, 'import_too_large', { maxMb: Math.round(config.maxBytes / MEGABYTE) });
      }

      if (isImportBusy(workspaceId)) {
        return apiError(res, 409, 'import_busy');
      }

      const filename = parseImportFilename(req.headers?.['x-import-filename']);

      // The estimate is a token count, not a conversion, but it slices and
      // measures the whole file — expensive enough to hold the workspace's lock.
      const prepared = await runExclusiveImport(workspaceId, async () => {
        const { inspectPdf, planPdfImport, estimatePdfImport } = await import('./sources/pdf');
        const inspection = await inspectPdf(bytes, config);
        const plan = planPdfImport(inspection, config);
        const estimate = await estimatePdfImport({ workspaceId, bytes, filename, inspection, plan, config });
        return { inspection, plan, estimate };
      });

      const upload = getUploadStore().create({
        workspaceId,
        userId: session.userId,
        bytes,
        filename,
        ...prepared,
      });

      deps.logger.info('Estimated a PDF import', {
        workspaceId,
        filename,
        uploadId: upload.id,
        inputTokens: prepared.estimate.inputTokens,
      });

      return res.json({
        uploadId: upload.id,
        filename,
        expiresAt: upload.expiresAt,
        // The ceiling travels with the numbers so the dialog can say how close
        // this document came to it without a second call for the configuration.
        estimate: { ...prepared.estimate, maxInputTokens: config.maxInputTokens },
      });
    } catch (err) {
      return failRequest(res, false, err, deps, 'POST import/pdf failed');
    }
  });

  /**
   * "Yes, convert it." Turns a parked upload into a draft, and spends the key.
   */
  router.post('/api/docs/:workspaceId/import/pdf/:uploadId/convert', async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);
    const uploadId = String(req.params.uploadId);
    let streaming = false;
    let owner: Session | null = null;

    try {
      const session = await requireImporter(req, res, workspaceId);
      if (!session) return undefined;
      owner = session;

      const upload = getUploadStore().get(uploadId, session);
      if (!upload) {
        // Expired, already converted, or someone else's — one answer for all
        // three, so the id space cannot be probed for what exists.
        return apiError(res, 410, 'import_draft_expired');
      }

      if (isImportBusy(workspaceId)) {
        return apiError(res, 409, 'import_busy');
      }

      streaming = beginStream(req, res);
      const onProgress = makeConvertReporter(streaming ? (progress) => writeProgress(res, progress) : undefined);

      const document = await runExclusiveImport(workspaceId, async () => {
        const { convertPdf } = await import('./sources/pdf');
        return convertPdf({
          workspaceId,
          bytes: upload.bytes,
          filename: upload.filename,
          onProgress,
        });
      });

      const created = getDraftStore().create({ workspaceId, userId: session.userId, document });
      deps.logger.info('Converted a PDF for import', {
        workspaceId,
        filename: upload.filename,
        draftId: created.id,
      });

      return finishWithDraft(res, streaming, created, document);
    } catch (err) {
      return failRequest(res, streaming, err, deps, 'POST import/pdf/convert failed');
    } finally {
      // Success or failure, the upload has served its purpose: the draft holds
      // the result, and a retry after a failed conversion should re-estimate
      // rather than silently spend the key again on the same bytes.
      if (owner) getUploadStore().delete(uploadId, owner);
    }
  });

  // ── Commit ───────────────────────────────────────────────────────────────

  /**
   * The draft, as the manager edited it, becomes a document.
   *
   * The body's markdown is trusted for its prose and not for its images: what
   * `assets/…` may mean is decided by `prepareCommit` against the draft, because
   * the binaries only exist there.
   */
  router.post('/api/docs/:workspaceId/import/commit', deps.jsonBody, async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);
    let streaming = false;

    try {
      const session = await requireImporter(req, res, workspaceId);
      if (!session) return undefined;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const draftId = String(body.draftId ?? '').trim();
      const filePath = String(body.filePath ?? '').trim();
      if (!filePath) {
        return apiError(res, 400, 'file_path_required');
      }

      const draft = draftId ? getDraftStore().get(draftId, session) : null;
      if (!draft) {
        return apiError(res, 410, 'import_draft_expired');
      }

      // A client that sends nothing is committing what it was given; the draft's
      // own markdown is the only honest default.
      const markdown = typeof body.markdown === 'string' ? body.markdown : draft.document.markdown;

      streaming = beginStream(req, res);
      const report = makeCommitReporter(streaming ? (progress) => writeProgress(res, progress) : undefined);

      const prepared = prepareCommit({ markdown, document: draft.document });
      const language = await pickDocumentLanguage(workspaceId, prepared.markdown);
      const content = prependSourceNote(prepared.markdown, buildSourceNote(draft.document.source, { language }));

      const result = await createDocument({
        workspaceId,
        userId: session.userId,
        filePath,
        content,
        assets: prepared.assets,
        commitMessage: commitMessageFor(filePath, draft.document.source),
        source: {
          import: draft.document.source.kind,
          name: draft.document.source.name,
          url: draft.document.source.url,
          pages: draft.document.source.pages,
        },
        onStep: report,
      });

      // Only once it has landed: a failed commit leaves the draft alone so the
      // manager can fix the path and try again without re-converting.
      getDraftStore().delete(draftId, session);

      deps.logger.info('Imported a document', {
        workspaceId,
        filePath: result.filePath,
        commitSha: result.commitSha,
        source: draft.document.source.kind,
      });

      const payload = {
        githubPath: result.filePath,
        commitSha: result.commitSha,
        droppedReferences: prepared.droppedReferences,
      };
      if (streaming) {
        return res.end(`${JSON.stringify({ type: 'result', ...payload })}\n`);
      }
      return res.json(payload);
    } catch (err) {
      // An unusable path or an occupied one is an answer, not a fault: the
      // manager can fix either from the dialog.
      if (err instanceof CreateDocumentRefusal) {
        return respond(res, streaming, err.status, err.apiCode, err.detail);
      }
      return failRequest(res, streaming, err, deps, 'POST import/commit failed');
    }
  });

  // ── Draft assets and disposal ────────────────────────────────────────────

  /**
   * One image out of a draft, for the preview.
   *
   * The bytes have not been committed and may never be, so this is not a
   * repository URL: it is owner-scoped, short-lived with the draft, and cached
   * privately. `nosniff` because the content type is the one the fetcher
   * validated, and nothing should second-guess it in the browser.
   */
  router.get('/api/docs/:workspaceId/import/draft/:draftId/asset/*assetPath', async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const session = await requireImporter(req, res, workspaceId);
      if (!session) return undefined;

      const draftId = String(req.params.draftId);
      const assetPath = splatPath(req.params.assetPath);
      const asset = getDraftStore().getAsset(draftId, session, assetPath);
      if (!asset) {
        return apiError(res, 404, 'document_not_found');
      }

      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('Cache-Control', 'private, max-age=600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(asset.bytes);
    } catch (err) {
      deps.logger.error('GET import/draft asset failed', err);
      return apiError(res, 500, 'internal_error');
    }
  });

  /** Cancelling the preview. 204 either way: the caller wanted it gone, and it is. */
  router.delete('/api/docs/:workspaceId/import/draft/:draftId', async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const session = await requireImporter(req, res, workspaceId);
      if (!session) return undefined;

      getDraftStore().delete(String(req.params.draftId), session);
      return res.status(204).end();
    } catch (err) {
      deps.logger.error('DELETE import/draft failed', err);
      return apiError(res, 500, 'internal_error');
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Manager plus push access, with every failure answered as `false`. */
async function canImportHere(workspaceId: string, userId: string, deps: ImportRouteDeps): Promise<boolean> {
  try {
    if (!(await deps.isManager(workspaceId, userId))) return false;
    return (await getDocsWriteAccess(workspaceId, userId)).canPush;
  } catch (err) {
    deps.logger.warn('import/status: could not resolve write access', err);
    return false;
  }
}

/**
 * Whether a key is available for this workspace — its own, or the server's.
 *
 * Resolved the way `resolveLLMConfig` does, minus the throw: this answers a
 * capability question for a menu, so "we could not ask the database" is `false`,
 * not a 500.
 */
async function hasOpenAIKey(workspaceId: string): Promise<boolean> {
  if (isOpenAIEnabled()) return true;
  try {
    const settings = await new WorkspaceStore().getOpenAISettings(workspaceId);
    return Boolean(settings?.apiKey);
  } catch {
    return false;
  }
}

/**
 * Opens an NDJSON response when the client asked for one.
 *
 * A conversion runs for a minute or more, so a client that wants a progress bar
 * gets one line per step and a final `result` line; everyone else gets the
 * single JSON body at the end.
 */
function beginStream(req: Req, res: Res): boolean {
  const accept = req.headers?.accept;
  const streaming = String(Array.isArray(accept) ? accept.join(',') : (accept ?? '')).includes(IMPORT_STREAM_TYPE);
  if (!streaming) return false;

  res.setHeader('Content-Type', `${IMPORT_STREAM_TYPE}; charset=utf-8`);
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  // Progress arrives in pieces; a proxy holding it back to buffer the whole
  // body would defeat the point.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return true;
}

function writeProgress(res: Res, progress: ImportStepProgress): void {
  res.write(`${JSON.stringify({ type: 'progress', ...progress })}\n`);
}

/** The `result` line (or body) every conversion ends with. */
function finishWithDraft(res: Res, streaming: boolean, created: CreatedDraft, document: ConvertedDocument): unknown {
  const payload = {
    draftId: created.id,
    expiresAt: created.expiresAt,
    markdown: document.markdown,
    title: document.title,
    suggestedPath: suggestImportPath(document.title),
    warnings: document.warnings,
    // Size, not the Buffer: the bytes stay on the server and the preview fetches
    // each one from the draft asset route. Serializing them here would put the
    // whole document in the response twice, base64-encoded.
    assets: document.assets.map((asset) => ({
      path: asset.path,
      bytes: asset.bytes.length,
      contentType: asset.contentType,
    })),
    rejectedAssets: document.rejectedAssets,
    source: document.source,
  };

  if (streaming) {
    res.end(`${JSON.stringify({ type: 'result', ...payload })}\n`);
    return undefined;
  }
  return res.json(payload);
}

/**
 * A refusal, wherever the response is up to.
 *
 * The status line is long gone once progress has been streamed, so a streaming
 * caller reads the outcome off the final line instead.
 */
function respond(
  res: Res,
  streaming: boolean,
  status: number,
  code: DocsApiErrorCode,
  detail?: DocsApiErrorDetail,
): unknown {
  if (streaming || res.headersSent) {
    res.end(`${JSON.stringify({ type: 'error', ...apiErrorBodyFor(code, detail), status })}\n`);
    return undefined;
  }
  return apiError(res, status, code, detail);
}

/**
 * Turns whatever came out of a source into an answer.
 *
 * A refusal is the manager's to act on and travels with its own status; anything
 * else is ours, and is logged before it becomes `import_conversion_failed`. A
 * refusal code the API does not know is treated as ours too — a source that grew
 * a new code before this file learned it must not leak a string the viewer
 * cannot translate.
 */
function failRequest(res: Res, streaming: boolean, err: unknown, deps: ImportRouteDeps, message: string): unknown {
  if (err instanceof ImportRefusal) {
    if (isDocsApiErrorCode(err.code)) {
      return respond(res, streaming, err.status, err.code, normalizeRefusalDetail(err.code, err.detail));
    }
    // Still a refusal — the status it chose is right — but the code is one the
    // viewer has no sentence for, so it travels as the catch-all instead.
    deps.logger.warn(`${message}: unknown refusal code`, { code: err.code });
    return respond(res, streaming, err.status, 'import_conversion_failed', { message: err.code });
  }

  deps.logger.error(message, err);
  const detail = { message: err instanceof Error ? err.message : String(err) };
  return respond(res, streaming, 500, 'import_conversion_failed', detail);
}

/**
 * Fills the holes the catalog sentence has and the thrower did not.
 *
 * The sources phrase their own details — `maxBytes` from the page fetcher,
 * `limit` from the draft store — and the English here asks for megabytes. This
 * is the one place that knows both, so it translates rather than making every
 * source learn the wording.
 */
function normalizeRefusalDetail(code: DocsApiErrorCode, detail?: DocsApiErrorDetail): DocsApiErrorDetail | undefined {
  if (code === 'import_too_large') {
    const bytes = detail?.maxBytes ?? detail?.limit;
    if (detail?.maxMb === undefined && typeof bytes === 'number') {
      return { ...detail, maxMb: Math.max(1, Math.round(bytes / MEGABYTE)) };
    }
  }

  if (code === 'import_url_blocked' && detail?.status === undefined) {
    // The site refused before answering at all (a private address, a dropped
    // connection). The sentence names a status, so it gets one a reader can read.
    return { ...detail, status: 'no response' };
  }

  return detail;
}

/**
 * `Import <basename> from <where it came from>`, in the same shape the Google
 * Docs import writes (services/google/import-service.ts), so `git log` reads the
 * same whichever menu item was used.
 */
function commitMessageFor(filePath: string, source: ImportSourceInfo): string {
  const basename = path.posix.basename(filePath);

  if (source.kind === 'url') {
    return `Import ${basename} from ${hostnameOf(source.url) ?? source.name}`;
  }
  if (source.kind === 'pdf') {
    const pages = typeof source.pages === 'number' && source.pages > 0 ? `, ${source.pages} pages` : '';
    return `Import ${basename} from PDF (${source.name}${pages})`;
  }
  return `Import ${basename} from ${source.name}`;
}

function hostnameOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The upload's own name, from `X-Import-Filename`.
 *
 * Percent-encoded UTF-8, because a header may not carry one: a Korean filename
 * would otherwise arrive mojibake or not at all. Directory separators are cut
 * rather than rejected — a browser that sends a full path means the last segment
 * — and the result never reaches the filesystem anyway; it is a label for the
 * title, the commit message and the source note.
 */
export function parseImportFilename(raw: unknown): string {
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string' || !header.trim()) return DEFAULT_PDF_FILENAME;

  let decoded = header.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Not valid percent-encoding: take it literally rather than losing the name.
  }

  const base = decoded.split(/[\\/]/).pop() ?? '';
  // Control characters go by code point rather than by a regular expression: a
  // header is a byte string, and a stray newline in it must not reach a commit
  // message or a log line.
  const cleaned = [...base]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .trim();
  return cleaned || DEFAULT_PDF_FILENAME;
}

/** Express 5 hands a `*name` segment over as an array of path parts. */
function splatPath(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join('/');
  return String(value ?? '');
}
