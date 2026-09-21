/**
 * HTTP surface for building a glossary out of documents somebody already has.
 *
 * Three calls, and the middle one is the feature: the seed documents have
 * already been converted to markdown by the import sources (a PDF, a URL, a
 * pasted file), so what arrives here are draft ids, and what goes back is a
 * table of proposed rows. Nothing is committed until the manager has edited
 * that table and asked for it — the same shape as import, for the same reason:
 * an LLM reading a paper for terms is a suggestion, not an authority.
 *
 * Registered from app.ts, which owns session reading, the body parsers and
 * express itself, so those arrive as dependencies rather than being
 * re-implemented here.
 *
 * IMPORTANT: these must be registered before `/api/docs/:workspaceId/*splat`,
 * which would otherwise swallow every `/api/docs/<id>/glossary` path.
 *
 * See docs/meeting-notes-and-glossary.md, 용어집 §3a.
 */

import { apiError, writeAccessErrorBody } from 'services/docs-editor/api-errors';
import { CreateDocumentRefusal } from 'services/docs-editor/create-document';
import { getDocsWriteAccess } from 'services/docs-editor/write-access';
import { getDraftStore } from 'services/import/draft-store';
import { type GlossaryCreateAt, GlossaryRefusal, commitGlossaryRows } from './commit';
import { extractGlossaryCandidates } from './extract';
import { loadGlossary } from './load';
import type { GlossaryLanguage } from './parse';
import type { GlossaryRowInput } from './table';

export interface GlossaryRouteDeps {
  readSession: (req: unknown) => Promise<{ workspaceId: string; userId: string } | null>;
  isManager: (workspaceId: string, userId: string) => Promise<boolean>;
  /** `express.json(...)`, for the two routes with a body. */
  jsonBody: unknown;
  logger: {
    info: (m: string, meta?: unknown) => void;
    warn: (m: string, meta?: unknown) => void;
    error: (m: string, e?: unknown) => void;
  };
}

// Express's router and handlers are untyped throughout app.ts (the receiver
// exposes them as `any`); these aliases keep that contained to one place.
type Router = { get: Handler; post: Handler };
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
  end: (chunk?: string) => void;
};

type Session = { workspaceId: string; userId: string };

export function registerGlossaryRoutes(router: Router, deps: GlossaryRouteDeps): void {
  /**
   * Session, then workspace, then CHOIR manager, then GitHub push access — the
   * same ladder import climbs, including on the read. Extraction spends the
   * workspace's OpenAI key and every path here ends in a commit, so a manager
   * whose GitHub account cannot push should be told before uploading a paper,
   * not after it has been converted and read.
   */
  const requireGlossaryEditor = async (req: Req, res: Res, workspaceId: string): Promise<Session | null> => {
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
   * What this folder already has: the chain of glossaries governing it, nearest
   * first, and how many terms they hold between them. The dialog opens on this
   * — "this folder has no glossary; create one?" is the whole of §3a's first
   * step — so it answers for a folder with nothing in it too.
   */
  router.get('/api/docs/:workspaceId/glossary', async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const session = await requireGlossaryEditor(req, res, workspaceId);
      if (!session) return undefined;

      const folder = folderParam(req.query.folder);
      const { entries, files } = await loadGlossary(workspaceId, asFolderPath(folder));

      return res.json({ folder, files, entries: entries.length, nearestFile: files[0] ?? null });
    } catch (err) {
      deps.logger.error('GET glossary failed', err);
      return apiError(res, 500, 'internal_error');
    }
  });

  /**
   * The seed documents in, proposed rows out. Not streamed: extraction is one
   * or two model calls over text that has already been converted, which is
   * seconds rather than the minutes a PDF conversion takes.
   */
  router.post('/api/docs/:workspaceId/glossary/extract', deps.jsonBody, async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);

    try {
      const session = await requireGlossaryEditor(req, res, workspaceId);
      if (!session) return undefined;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const folder = folderParam(body.folder);

      const language = languageParam(body.language);
      if (language === 'invalid') {
        return apiError(res, 400, 'invalid_language');
      }

      const draftIds = Array.isArray(body.draftIds) ? body.draftIds.map((id) => String(id ?? '').trim()) : [];
      const markdown = seedMarkdown(draftIds, session);
      if (markdown === null) {
        // Missing, expired, already used or someone else's — one answer for all
        // of them, as on the import routes, so the id space cannot be probed.
        return apiError(res, 410, 'import_draft_expired');
      }

      const { entries, files } = await loadGlossary(workspaceId, asFolderPath(folder));
      const candidates = await extractGlossaryCandidates({
        workspaceId,
        markdown,
        existing: entries,
        ...(language ? { language } : {}),
      });

      if (candidates.length === 0) {
        // Not a fault: a document that defines nothing, or one whose every term
        // the glossary already has. The dialog says so and offers the editor.
        return apiError(res, 422, 'glossary_no_terms');
      }

      deps.logger.info('Extracted glossary candidates', {
        workspaceId,
        folder,
        drafts: draftIds.length,
        candidates: candidates.length,
      });

      return res.json({ candidates, existing: entries.length, nearestFile: files[0] ?? null });
    } catch (err) {
      return failRequest(res, err, deps, 'POST glossary/extract failed');
    }
  });

  /** The table as the manager edited it becomes a commit on `GLOSSARY.md`. */
  router.post('/api/docs/:workspaceId/glossary/commit', deps.jsonBody, async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);

    try {
      const session = await requireGlossaryEditor(req, res, workspaceId);
      if (!session) return undefined;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const rows = parseRows(body.rows);
      if (rows.length === 0) {
        return apiError(res, 422, 'glossary_no_terms');
      }

      const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
      const result = await commitGlossaryRows({
        workspaceId,
        userId: session.userId,
        folder: folderParam(body.folder),
        rows,
        ...(fileName ? { fileName } : {}),
        createAt: body.createAt === 'folder' ? ('folder' as GlossaryCreateAt) : ('nearest' as GlossaryCreateAt),
      });

      deps.logger.info('Committed glossary rows', {
        workspaceId,
        path: result.path,
        added: result.added,
        created: result.created,
      });

      return res.json(result);
    } catch (err) {
      return failRequest(res, err, deps, 'POST glossary/commit failed');
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Every seed draft's markdown, under a `# <title>` each.
 *
 * The heading is what lets the extraction credit a term to the document it came
 * from (the chunker cuts at `# ` first), and it is also the simplest thing that
 * stops two papers from reading as one. `null` means one of the ids was not
 * usable, which fails the whole call: a glossary built from half the documents
 * the manager chose is a silently wrong answer.
 */
function seedMarkdown(draftIds: string[], session: Session): string | null {
  if (draftIds.length === 0) return null;

  const pieces: string[] = [];
  for (const id of draftIds) {
    const draft = id ? getDraftStore().get(id, session) : null;
    if (!draft) return null;
    const title = draft.document.title?.trim() || draft.document.source.name;
    pieces.push(`# ${title}\n\n${draft.document.markdown.trim()}`);
  }

  return pieces.join('\n\n');
}

/** Rows as the editable preview sends them, with anything unusable dropped. */
function parseRows(value: unknown): GlossaryRowInput[] {
  if (!Array.isArray(value)) return [];

  const rows: GlossaryRowInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const term = typeof record.term === 'string' ? record.term.trim() : '';
    if (!term) continue;

    const aliases = Array.isArray(record.aliases)
      ? record.aliases.filter((alias): alias is string => typeof alias === 'string').map((alias) => alias.trim())
      : [];

    rows.push({
      term,
      aliases: aliases.filter((alias) => alias.length > 0),
      description: typeof record.description === 'string' ? record.description.trim() : '',
    });
  }
  return rows;
}

/** A repository-relative folder, with no leading or trailing slash. `''` is the root. */
function folderParam(value: unknown): string {
  const raw = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/** `loadGlossary` reads a bare path as a document; the trailing slash says "folder". */
function asFolderPath(folder: string): string {
  return folder ? `${folder}/` : '';
}

/** The two languages the glossary template and the prompt know, or `'invalid'`. */
function languageParam(value: unknown): GlossaryLanguage | undefined | 'invalid' {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'ko' || value === 'en') return value;
  return 'invalid';
}

/**
 * Turns whatever came out of the services into an answer. A refusal is the
 * manager's to act on and travels with its own status and code; anything else
 * is ours, and is logged before it becomes a 500.
 */
function failRequest(res: Res, err: unknown, deps: GlossaryRouteDeps, message: string): unknown {
  if (err instanceof GlossaryRefusal) {
    return apiError(res, err.status, err.apiCode, err.detail);
  }
  // An occupied or unusable path, from the create inside the commit.
  if (err instanceof CreateDocumentRefusal) {
    return apiError(res, err.status, err.apiCode, err.detail);
  }
  deps.logger.error(message, err);
  return apiError(res, 500, 'internal_error');
}
