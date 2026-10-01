import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'services/common/logger';
import { parseMarkdownToTree } from 'services/document';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService, type MarkdownFile } from 'services/github';
import { renameDocState } from 'services/google/gdocs-state';
import { hasOpenReview } from 'services/google/review-service';
import { scheduleQmdWarmup } from 'services/retrieval/warmup';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { PathMapService } from 'services/workspace/path-map-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import type { DocsApiErrorCode, DocsApiErrorDetail } from './api-errors';
import { documentExists } from './document-exists';
import { normalizeDocumentPath } from './document-path';
import { countInboundLinks } from './inbound-links';
import { listMarkdownPaths } from './list-markdown-paths';

/** Where provenance sidecars live, mirroring `contextFilePath` in services/document/provenance. */
const CONTEXT_DIR = '.choir/context';

export interface RenameDocumentResult {
  commitSha: string;
  from: string;
  to: string;
  /** How many other documents link to the old path, and now link to nothing. */
  inboundLinks: number;
}

export interface RenameCheckResult {
  from: string;
  to: string;
  /** Something already lives at `to`, so the rename would be refused. */
  exists: boolean;
  /** `from` has an open Google Docs decision, so the rename would be refused. */
  reviewPending: boolean;
  inboundLinks: number;
  /** A pure rename rather than a move, which is what the dialog's wording turns on. */
  sameFolder: boolean;
}

/**
 * A refusal the caller can answer with as-is.
 *
 * None of these is a fault: the path is unusable, something already lives at the
 * destination, the document is not there, or a Google Docs review is waiting on
 * somebody. All four are answers the manager can act on, so they carry the API
 * code and status that say which, rather than arriving at the route as an opaque
 * 500. Same shape as `CreateDocumentRefusal`.
 */
export class RenameDocumentRefusal extends Error {
  readonly status: number;
  readonly apiCode: DocsApiErrorCode;
  readonly detail?: DocsApiErrorDetail;

  constructor(status: number, apiCode: DocsApiErrorCode, detail?: DocsApiErrorDetail) {
    super(apiCode);
    this.name = 'RenameDocumentRefusal';
    this.status = status;
    this.apiCode = apiCode;
    this.detail = detail;
  }
}

/**
 * Renames or moves a markdown document. A move is the same operation: the folder
 * is part of the path, so `to` merely having a different parent changes nothing
 * about what has to happen.
 *
 * Follows delete's order — GitHub first, local state after — for the reason
 * save-document spells out: a rejected push must not leave CHOIR serving a
 * repository state GitHub does not have. The commit is tagged `[choir-auto]`,
 * so the push webhook skips it and nothing else will ever reconcile the mirror;
 * every store keyed by the old path has to be moved here or it is silently lost.
 *
 * The one thing it does NOT do is rewrite the links in other documents
 * (docs/meeting-notes-and-glossary.md: 1차에서는 고치지 않는다). Instead it
 * counts them and hands the number back, so the dialog can warn before the
 * manager commits to it and the follow-up can be written knowing what it costs.
 *
 * No provenance record is written. Provenance is the record of why a document's
 * CONTENT changed, and a rename changes none of it; filing one would put an
 * empty diff in the viewer's history panel and claim an edit that nobody made.
 * The sidecars that already exist move with the document, which is the part that
 * actually matters — left behind, the document's whole history disappears from
 * the viewer.
 */
export async function renameDocument(params: {
  workspaceId: string;
  userId: string;
  from: string;
  to: string;
}): Promise<RenameDocumentResult> {
  const { workspaceId, userId } = params;
  const { from, to } = normalizePair(params.from, params.to);

  const repoInfo = await getGithubRepo(workspaceId);
  if (!repoInfo) {
    throw new Error('No GitHub repository configured for workspace');
  }

  const mirror = WorkspaceMirrorService.getInstance();
  const store = new WorkspaceStore();
  const repoRoot = mirror.getRepoRoot(workspaceId);

  // ── Every refusal happens before the commit ───────────────────────────────
  const content = await mirror.readMirrorFile(workspaceId, from);
  if (content === null) {
    throw new RenameDocumentRefusal(404, 'document_not_found', { path: from });
  }

  if (await documentExists({ workspaceId, userId, filePath: to, repo: repoInfo })) {
    throw new RenameDocumentRefusal(409, 'document_exists', { path: to });
  }

  if (await hasOpenReview(workspaceId, from)) {
    throw new RenameDocumentRefusal(409, 'rename_review_pending', { path: from });
  }

  // Counted against the repository as the manager last saw it, before anything
  // moves, so the number reported is the number the dialog warned about.
  const inboundLinks = await countInboundLinks(repoRoot, from);

  // ── (1) The sidecars that have to travel with the document ────────────────
  const sidecars = await readContextSidecars(repoRoot, from);

  // ── (2) One commit: the document and its history arrive and leave together ─
  const { commitSha } = await GithubService.getInstance().commitFilesWithContext({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
    message: `Rename ${from} → ${to}`,
    files: [
      { path: to, content },
      ...sidecars.map((sidecar) => ({ path: `${CONTEXT_DIR}/${to}/${sidecar.id}`, content: sidecar.content })),
    ],
    deletions: [from, ...sidecars.map((sidecar) => `${CONTEXT_DIR}/${from}/${sidecar.id}`)],
    workspaceId,
    userId,
  });

  // ── (3) Mirror: the viewer and Q&A read this, not GitHub ──────────────────
  await mirror.writeMarkdownFile(workspaceId, to, content);
  await mirror.removeMarkdownFile(workspaceId, from);
  await moveContextDir(repoRoot, from, to);

  // ── (4) Path map (QMD handle ↔ path) is add-only, so re-save what survives ─
  try {
    await PathMapService.getInstance().save(workspaceId, await listMarkdownPaths(repoRoot));
  } catch (error) {
    Logger.warn('renameDocument: failed to rewrite the path map', error as Error);
  }

  // ── (5) Vector store: the same content under the new path ─────────────────
  await refreshVectorStoreEntry({ workspaceId, from, to, content, repoInfo });
  scheduleQmdWarmup({ workspaceId, reason: 'docs-editor-rename' });

  // ── (6) Google Docs replica: mapping, state and baselines are path-keyed ───
  try {
    const mapping = await store.getGoogleDocMapping(workspaceId, from);
    if (mapping) {
      // There is no "move" on the config, and the setter refuses a fileId that
      // is linked elsewhere — so the old key has to go first, or re-keying the
      // mapping would collide with itself.
      await store.removeGoogleDocMapping(workspaceId, from);
      await store.setGoogleDocMapping(workspaceId, to, {
        fileId: mapping.fileId,
        webViewLink: mapping.webViewLink,
        linkedBy: mapping.linkedBy,
        // A mapping written before modes existed has none, and the setter
        // requires one. `preserve` is the conservative guess: it holds pushes
        // back for a person to apply, where guessing `replica` would let the
        // next publish replace the body of a document somebody wrote.
        mode: mapping.mode ?? 'preserve',
      });
      if (!mapping.mode) {
        Logger.warn('renameDocument: re-keyed a Google Doc mapping that had no mode', { workspaceId, from, to });
      }
      await renameDocState(workspaceId, from, to);
    }
  } catch (error) {
    Logger.warn('renameDocument: failed to re-key the Google Docs replica', error as Error);
  }

  // ── (7) Read-only list ────────────────────────────────────────────────────
  try {
    await renameReadOnlyEntry(store, workspaceId, from, to);
  } catch (error) {
    Logger.warn('renameDocument: failed to re-key the read-only list', error as Error);
  }

  Logger.info('renameDocument: renamed document', { workspaceId, from, to, commitSha, inboundLinks, userId });

  return { commitSha, from, to, inboundLinks };
}

/**
 * What the rename dialog needs before it offers the button: whether the
 * destination is taken, whether a review is in the way, and how many links are
 * about to break. Never commits, and never refuses for anything but an unusable
 * path — the two blocking conditions come back as fields so the dialog can
 * explain them in place rather than as an error after the fact.
 */
export async function checkRename(params: {
  workspaceId: string;
  from: string;
  to: string;
  /** The asking manager, so the GitHub look uses their token as the rename will. */
  userId?: string;
}): Promise<RenameCheckResult> {
  const { workspaceId } = params;
  const { from, to } = normalizePair(params.from, params.to);

  const mirror = WorkspaceMirrorService.getInstance();
  const repoRoot = mirror.getRepoRoot(workspaceId);

  const repoInfo = await getGithubRepo(workspaceId);
  if (!repoInfo) {
    throw new Error('No GitHub repository configured for workspace');
  }

  const [exists, reviewPending, inboundLinks] = await Promise.all([
    documentExists({ workspaceId, userId: params.userId, filePath: to, repo: repoInfo }),
    hasOpenReview(workspaceId, from),
    countInboundLinks(repoRoot, from),
  ]);

  return {
    from,
    to,
    exists,
    reviewPending,
    inboundLinks,
    sameFolder: path.posix.dirname(from) === path.posix.dirname(to),
  };
}

/**
 * Both paths through the same rule the rest of the editor writes by, refusing
 * before anything is read. A rename onto the path it already has is refused
 * rather than treated as a no-op: it would commit a file deletion and a file
 * creation for the identical path, and there is no wording for that in which
 * the manager got what they asked for.
 */
function normalizePair(rawFrom: string, rawTo: string): { from: string; to: string } {
  const from = normalizeDocumentPath(rawFrom);
  const to = normalizeDocumentPath(rawTo);
  if (!from || !to || from === to) {
    throw new RenameDocumentRefusal(400, 'invalid_document_path');
  }
  return { from, to };
}

/**
 * The document's encrypted provenance sidecars, read from the mirror.
 *
 * They are committed under the new path and deleted from the old one in the
 * SAME commit as the document: any other order leaves a window in which the
 * viewer's history panel shows a document with no past, and a failure between
 * two commits would make that permanent.
 */
async function readContextSidecars(repoRoot: string, docPath: string): Promise<Array<{ id: string; content: string }>> {
  const dir = containedContextDir(repoRoot, docPath);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // A document that was never edited through CHOIR has none.
  }

  const sidecars: Array<{ id: string; content: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      sidecars.push({ id: entry.name, content: await fs.promises.readFile(path.join(dir, entry.name), 'utf-8') });
    } catch (error) {
      // Skipping would silently drop a record from the document's history, and
      // the commit is not written yet, so this is the moment to stop.
      throw new Error(`Cannot read provenance sidecar ${docPath}/${entry.name}: ${(error as Error).message}`);
    }
  }
  return sidecars;
}

/** Moves the mirror's `.choir/context/<from>/` to `<to>/`, across devices if need be. */
async function moveContextDir(repoRoot: string, from: string, to: string): Promise<void> {
  const source = containedContextDir(repoRoot, from);
  const target = containedContextDir(repoRoot, to);
  if (!fs.existsSync(source)) return;

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.rename(source, target);
    return;
  } catch (error) {
    // EXDEV (the mirror spanning a mount) and ENOTEMPTY are the ones worth
    // surviving; copying then removing gets the same result either way.
    Logger.warn(`renameDocument: falling back to copy for ${source}`, error as Error);
  }

  await fs.promises.cp(source, target, { recursive: true, force: true });
  await fs.promises.rm(source, { recursive: true, force: true });
}

/** The sidecar folder for a document, refusing a path that escapes `.choir/context`. */
function containedContextDir(repoRoot: string, docPath: string): string {
  const root = path.resolve(repoRoot, CONTEXT_DIR);
  const dir = path.resolve(root, path.posix.normalize(docPath).replace(/^\/+/, ''));
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error(`Forbidden context path: ${docPath}`);
  }
  return dir;
}

/**
 * Replaces the in-memory index entry, so Q&A answers from the new path from the
 * next question on rather than from the next full sync.
 *
 * Not shared with `saveEditedDocument`'s block, which deliberately keeps the
 * entry's existing `githubUrl`: here the URL is exactly what changed, so the
 * old one would send every citation to a 404.
 */
async function refreshVectorStoreEntry(params: {
  workspaceId: string;
  from: string;
  to: string;
  content: string;
  repoInfo: { owner: string; repo: string; branch?: string };
}): Promise<void> {
  try {
    const vectorStore = VectorStoreService.getInstance();
    await vectorStore.ensureLoaded(params.workspaceId);
    const name = params.to.split('/').pop() || params.to;
    const branchSegment = params.repoInfo.branch || 'main';
    const encodedPath = params.to
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    const renamed: MarkdownFile = {
      name,
      path: params.to,
      content: params.content,
      githubUrl: `https://github.com/${params.repoInfo.owner}/${params.repoInfo.repo}/blob/${branchSegment}/${encodedPath}`,
      tree: parseMarkdownToTree(params.content, name),
    };

    // De-duped by full path, as everywhere else: a sibling sharing this basename
    // is a different document and must not be dropped.
    const next = vectorStore
      .getAllMarkdownFiles(params.workspaceId)
      .filter((file) => file.path !== params.from && file.path !== params.to);
    next.push(renamed);
    vectorStore.setLoadedMarkdownFiles(next, params.workspaceId);
  } catch (error) {
    Logger.warn('renameDocument: failed to move the vector store entry', error as Error);
  }
}

/**
 * Carries a read-only mark across the rename.
 *
 * Entries are paths today and were basenames in older workspaces (see
 * services/workspace/read-only.ts), and both forms have to be recognised: a
 * mark left behind would either stop protecting the document or, worse, start
 * protecting whatever is created at the old path next. The replacement is always
 * written in the current path form, so the list gets a little more precise each
 * time a document moves.
 */
async function renameReadOnlyEntry(
  store: WorkspaceStore,
  workspaceId: string,
  from: string,
  to: string,
): Promise<void> {
  const entries = await store.getReadOnlyFiles(workspaceId);
  if (entries.length === 0) return;

  const fromBase = from.split('/').pop();
  const matches = (entry: string) => entry === from || (fromBase !== undefined && entry === fromBase);
  if (!entries.some(matches)) return;

  const next = entries.filter((entry) => !matches(entry));
  if (!next.includes(to)) next.push(to);
  await store.setReadOnlyFiles(workspaceId, next);
}
