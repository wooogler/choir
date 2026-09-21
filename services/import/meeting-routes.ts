/**
 * HTTP surface for "회의록 만들기".
 *
 * Two calls, then the import commit everybody else uses: the transcript is
 * parsed and priced (`POST .../import/meeting`), the manager approves, and the
 * conversion streams into a draft (`POST .../import/meeting/:uploadId/convert`).
 * The draft is an ordinary import draft, so `POST .../import/commit` — preview
 * edits, source note, assets, provenance and all — needs no meeting-specific
 * branch at all.
 *
 * Separate from `routes.ts` because the two grew apart: import takes a file and
 * asks where it should land afterwards, while a meeting note is told where it
 * lands before anything is converted (docs/meeting-notes-and-glossary.md, 결정 2).
 * The auth ladder and the NDJSON shape are deliberately identical, and the small
 * helpers that produce them are copied rather than imported — `routes.ts` keeps
 * them private and this stage may not edit it.
 *
 * Registered from app.ts, and — like the import routes — BEFORE
 * `/api/docs/:workspaceId/*splat`, which would otherwise swallow every
 * `/api/docs/<id>/import/meeting...` path.
 */

import {
  type DocsApiErrorCode,
  type DocsApiErrorDetail,
  apiError,
  apiErrorBodyFor,
  isDocsApiErrorCode,
  writeAccessErrorBody,
} from 'services/docs-editor/api-errors';
import { getDocsWriteAccess } from 'services/docs-editor/write-access';
import { loadGlossary } from 'services/glossary/load';
import { glossaryPromptBlock } from 'services/glossary/prompt-block';
import { resolveProjectForPath } from 'services/projects/project-index';
import { getDraftStore } from './draft-store';
import { isImportBusy, runExclusiveImport } from './mutex';
import { type ImportStepProgress, makeConvertReporter } from './progress';
import { ImportRefusal } from './types';

/** The one content type the conversion streams progress as. */
const IMPORT_STREAM_TYPE = 'application/x-ndjson';

const MEGABYTE = 1024 * 1024;

/** The glossary budget the conversion uses, so the estimate counts the same block. */
const GLOSSARY_MAX_TOKENS = 1500;

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
  write: (chunk: string) => boolean;
  end: (chunk?: string) => void;
  flushHeaders?: () => void;
  headersSent?: boolean;
};

type Session = { workspaceId: string; userId: string };

export interface MeetingRouteDeps {
  readSession: (req: unknown) => Promise<{ workspaceId: string; userId: string } | null>;
  isManager: (workspaceId: string, userId: string) => Promise<boolean>;
  /** `express.json(...)` — both routes carry a JSON body. */
  jsonBody: unknown;
  logger: {
    info: (m: string, meta?: unknown) => void;
    warn: (m: string, meta?: unknown) => void;
    error: (m: string, e?: unknown) => void;
  };
}

export function registerMeetingRoutes(router: Router, deps: MeetingRouteDeps): void {
  /**
   * Session, workspace, CHOIR manager, GitHub push access — the same four rungs
   * `routes.ts` climbs, for the same reason: a meeting note ends in a commit, so
   * a manager who cannot push should be told before the workspace's key pays for
   * an hour of transcript rather than after.
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

  /**
   * A transcript and the meeting's details in, an estimate out. No model is
   * called: parsing is local, and so is the token count (see `estimate.ts`).
   */
  router.post('/api/docs/:workspaceId/import/meeting', deps.jsonBody, async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);

    try {
      const session = await requireImporter(req, res, workspaceId);
      if (!session) return undefined;

      const body = (req.body ?? {}) as Record<string, unknown>;

      // Loaded here rather than at the top of the file, the way `routes.ts`
      // loads its sources: nothing in this module's import graph should be paid
      // for by a process that never makes a meeting note.
      const { parseMeetingMeta, meetingTargetPath, estimateMeetingImport, getMeetingUploadStore, resolveMeetingModel } =
        await import('./sources/meeting');

      // The meeting details first: they are the cheapest thing to refuse, and a
      // manager who typed the wrong folder should not wait for a parse.
      const meta = parseMeetingMeta(body.meta);
      if (!meta.ok) {
        return apiError(res, 400, 'meeting_meta_invalid', { message: meta.message });
      }

      const filename = optionalString(body.filename);
      const text = optionalString(body.text);
      const bytes = decodeUpload(body.contentBase64);
      if (!bytes && !text) {
        return apiError(res, 422, 'meeting_transcript_empty');
      }

      if (isImportBusy(workspaceId)) {
        return apiError(res, 409, 'import_busy');
      }

      const targetPath = meetingTargetPath(meta.value);

      // Held for the same reason the PDF estimate is: it is the workspace's one
      // import slot, and a parse that is running should not race a conversion.
      const prepared = await runExclusiveImport(workspaceId, async () => {
        const { loadTranscript } = await import('./sources/text');
        const transcript = await loadTranscript({ filename, bytes, text });
        const { glossaryBlock, aliasGroups } = await meetingContext(workspaceId, meta.value.folder, targetPath, {
          transcript: transcript.segments.map((segment) => segment.text).join('\n'),
          context: meta.value.context,
        });

        const model = await resolveMeetingModel(workspaceId);

        return {
          transcript,
          estimate: estimateMeetingImport({
            transcript,
            meta: meta.value,
            model,
            glossaryBlock,
            aliasGroups,
          }),
        };
      });

      const upload = getMeetingUploadStore().create({
        workspaceId,
        userId: session.userId,
        // A paste has no bytes of its own; what it costs the store is its text.
        bytes: bytes ?? Buffer.from(text ?? '', 'utf8'),
        ...(filename ? { filename } : {}),
        transcript: prepared.transcript,
        meta: meta.value,
        estimate: prepared.estimate,
      });

      deps.logger.info('Estimated a meeting note', {
        workspaceId,
        uploadId: upload.id,
        kind: prepared.transcript.kind,
        utterances: prepared.estimate.utterances,
        inputTokens: prepared.estimate.inputTokens,
      });

      return res.json({
        uploadId: upload.id,
        expiresAt: upload.expiresAt,
        // What we made of the file, so the dialog can say "4 speakers, 58
        // minutes" before the manager commits to paying for it.
        detected: {
          kind: prepared.transcript.kind,
          speakers: prepared.transcript.stats.speakers,
          utterances: prepared.transcript.stats.utterances,
          ...(prepared.estimate.minutes ? { minutes: prepared.estimate.minutes } : {}),
        },
        estimate: prepared.estimate,
        targetPath,
      });
    } catch (err) {
      return failRequest(res, false, err, deps, 'POST import/meeting failed');
    }
  });

  /**
   * "Yes, make it." Turns a parked transcript into a draft, and spends the key.
   */
  router.post('/api/docs/:workspaceId/import/meeting/:uploadId/convert', async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);
    const uploadId = String(req.params.uploadId);
    let streaming = false;
    let owner: Session | null = null;

    try {
      const session = await requireImporter(req, res, workspaceId);
      if (!session) return undefined;
      owner = session;

      const { getMeetingUploadStore, meetingTargetPath, convertMeeting } = await import('./sources/meeting');

      const upload = getMeetingUploadStore().get(uploadId, session);
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

      const targetPath = meetingTargetPath(upload.meta);
      const document = await runExclusiveImport(workspaceId, async () => {
        const { glossary, aliasGroups } = await meetingContext(workspaceId, upload.meta.folder, targetPath, {
          transcript: upload.transcript.segments.map((segment) => segment.text).join('\n'),
          context: upload.meta.context,
        });

        return convertMeeting({
          workspaceId,
          userId: session.userId,
          transcript: upload.transcript,
          meta: upload.meta,
          filename: upload.filename,
          glossary,
          aliasGroups,
          onProgress,
        });
      });

      const created = getDraftStore().create({ workspaceId, userId: session.userId, document });
      deps.logger.info('Made a meeting note', {
        workspaceId,
        draftId: created.id,
        targetPath,
        unknownTerms: document.unknownTerms.length,
      });

      const payload = {
        draftId: created.id,
        expiresAt: created.expiresAt,
        markdown: document.markdown,
        title: document.title,
        // Already decided in the dialog, unlike every other import: the manager
        // chose the folder and the file name before this ran.
        suggestedPath: targetPath,
        warnings: document.warnings,
        assets: [],
        rejectedAssets: document.rejectedAssets,
        source: document.source,
        // The two extras the meeting preview shows: the glossary card's
        // candidates, and who the server could put a name to.
        unknownTerms: document.unknownTerms,
        speakerMap: document.speakerMap,
      };

      if (streaming) {
        res.end(`${JSON.stringify({ type: 'result', ...payload })}\n`);
        return undefined;
      }
      return res.json(payload);
    } catch (err) {
      return failRequest(res, streaming, err, deps, 'POST import/meeting/convert failed');
    } finally {
      // Success or failure, the upload has served its purpose: the draft holds
      // the result, and a retry after a failed conversion should re-estimate
      // rather than silently spend the key again on the same transcript.
      if (owner) {
        const { getMeetingUploadStore } = await import('./sources/meeting');
        getMeetingUploadStore().delete(uploadId, owner);
      }
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * The two things the folder knows: how this project spells its words, and which
 * spellings belong to one person.
 *
 * The glossary is the target folder's chain rather than the whole repository —
 * unlike a PDF, a meeting note's path is known before the conversion, so the
 * nearest glossary can win the way the design says it should. The alias groups
 * come from the project's `members.aliases`, values only: the project file keys
 * them by Slack user ID and deliberately stores no names, so a group is "these
 * spellings are one person" and nothing more.
 */
async function meetingContext(
  workspaceId: string,
  folder: string,
  targetPath: string,
  text: { transcript: string; context?: string },
) {
  const [glossary, project] = await Promise.all([
    loadGlossary(workspaceId, `${folder}/`).catch(() => ({ entries: [], files: [] })),
    resolveProjectForPath(workspaceId, targetPath).catch(() => null),
  ]);

  const aliasGroups = Object.values(project?.settings.members.aliases ?? {}).filter((group) => group.length > 1);

  return {
    glossary: glossary.entries,
    aliasGroups,
    glossaryBlock: glossaryPromptBlock(glossary.entries, {
      text: `${text.transcript}\n${text.context ?? ''}`,
      maxTokens: GLOSSARY_MAX_TOKENS,
    }),
  };
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : undefined;
}

/**
 * The transcript, when the browser sent a file rather than a paste.
 *
 * Base64 in a JSON body rather than a raw upload, because this request also
 * carries the meeting's details and splitting them across two calls would let
 * them disagree. The size ceiling is `loadTranscript`'s, checked there against
 * the decoded length — base64 inflates by a third and the limit is about text.
 */
function decodeUpload(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 ? bytes : undefined;
}

/**
 * Opens an NDJSON response when the client asked for one. Copied from
 * `routes.ts`, which keeps it private.
 */
function beginStream(req: Req, res: Res): boolean {
  const accept = req.headers?.accept;
  const streaming = String(Array.isArray(accept) ? accept.join(',') : (accept ?? '')).includes(IMPORT_STREAM_TYPE);
  if (!streaming) return false;

  res.setHeader('Content-Type', `${IMPORT_STREAM_TYPE}; charset=utf-8`);
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return true;
}

function writeProgress(res: Res, progress: ImportStepProgress): void {
  res.write(`${JSON.stringify({ type: 'progress', ...progress })}\n`);
}

/**
 * A refusal, wherever the response is up to. The status line is long gone once
 * progress has been streamed, so a streaming caller reads the outcome off the
 * final line instead. Copied from `routes.ts`.
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
 * Turns whatever came out of the pipeline into an answer. A refusal is the
 * manager's to act on and travels with its own status; anything else is ours,
 * and is logged before it becomes `import_conversion_failed`. Copied from
 * `routes.ts`, minus the PDF-only detail rewriting it does not need.
 */
function failRequest(res: Res, streaming: boolean, err: unknown, deps: MeetingRouteDeps, message: string): unknown {
  if (err instanceof ImportRefusal) {
    if (isDocsApiErrorCode(err.code)) {
      return respond(res, streaming, err.status, err.code, normalizeRefusalDetail(err.code, err.detail));
    }
    deps.logger.warn(`${message}: unknown refusal code`, { code: err.code });
    return respond(res, streaming, err.status, 'import_conversion_failed', { message: err.code });
  }

  deps.logger.error(message, err);
  const detail = { message: err instanceof Error ? err.message : String(err) };
  return respond(res, streaming, 500, 'import_conversion_failed', detail);
}

/** The English sentence asks for megabytes; the thrower counted bytes. */
function normalizeRefusalDetail(code: DocsApiErrorCode, detail?: DocsApiErrorDetail): DocsApiErrorDetail | undefined {
  if (code === 'import_too_large') {
    const bytes = detail?.maxBytes ?? detail?.limit;
    if (detail?.maxMb === undefined && typeof bytes === 'number') {
      return { ...detail, maxMb: Math.max(1, Math.round(bytes / MEGABYTE)) };
    }
  }
  return detail;
}
