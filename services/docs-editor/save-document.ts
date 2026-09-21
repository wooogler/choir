import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'services/common/logger';
import { parseMarkdownToTree } from 'services/document';
import { DocumentUpdateService } from 'services/document/document-update-service';
import { enrichWorkspaceImageCaptions } from 'services/document/image-captions';
import {
  type ProvenanceRecord,
  type ProvenanceType,
  buildContextFile,
  persistContextToMirror,
} from 'services/document/provenance';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService, type MarkdownFile } from 'services/github';
import { schedulePublish } from 'services/google/replica-publisher';
import type { ImportAsset } from 'services/import/types';
import { scheduleQmdWarmup } from 'services/retrieval/warmup';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { normalizeDocumentPath } from './document-path';

export interface SaveDocumentResult {
  commitSha: string;
}

/**
 * Another markdown file that belongs to the same change as the document.
 *
 * The case this exists for is the glossary: a manager who commits a meeting
 * note also ticks the terms the transcript taught, and those rows have to land
 * in the same commit as the note — two commits would mean a moment (or, if the
 * second one fails, forever) where the document cites a vocabulary the
 * repository does not have. The file may already exist (rows appended to a
 * `GLOSSARY.md`) or not (the folder's first glossary); both are one tree entry.
 *
 * See docs/meeting-notes-and-glossary.md, 용어집 §5.
 */
export interface CompanionEdit {
  /** Repository-relative markdown path; not the document's own path. */
  path: string;
  content: string;
}

/**
 * The phases a save walks through, for a caller that streams progress to a
 * person waiting on it (the import flows do; an ordinary editor save does not).
 *
 * `checking` and `done` belong to the caller — `createDocument` reports them
 * around the work below — and are in the same vocabulary so one listener covers
 * the whole operation.
 */
export type SaveStep = 'checking' | 'committing' | 'mirroring' | 'indexing' | 'done';

export type SaveStepListener = (step: SaveStep) => void;

/**
 * Wraps an optional step listener into one the save can call freely: progress is
 * decoration on top of work that has already happened, so a listener that throws
 * (a closed NDJSON stream, say) must not take the save down with it. Same shape,
 * and the same reason, as `makeProgressReporter` in services/google/import-steps.ts.
 */
export function makeStepReporter(onStep?: SaveStepListener): (step: SaveStep) => void {
  if (!onStep) return () => {};

  return (step: SaveStep) => {
    try {
      onStep(step);
    } catch {
      // See above.
    }
  };
}

/**
 * Saves an edited markdown document: stages it to the workspace mirror, commits
 * to GitHub on the workspace's configured branch, then refreshes in-memory
 * vector store and schedules QMD index warmup so Q&A retrieval sees the change.
 */
export async function saveEditedDocument(params: {
  workspaceId: string;
  userId: string;
  filePath: string;
  content: string;
  commitMessage: string;
  /**
   * How the change is recorded in provenance. Creating a document runs through
   * this same path — commit, mirror, index, publish — and differs only in that
   * the viewer should call it a new file rather than an edit.
   */
  provenanceType?: ProvenanceType;
  /**
   * Binaries the document references (images an import carried in). They land in
   * the SAME commit as the markdown, so the document is never committed pointing
   * at files that do not exist yet, and are written to the mirror beside it.
   */
  assets?: ImportAsset[];
  /**
   * Where the change came from, merged over the default `{ editor: 'web' }`. An
   * import fills in which source it came from and what it was called there.
   */
  source?: ProvenanceRecord['source'];
  /**
   * Other markdown files that change with this one, in the SAME commit. See
   * {@link CompanionEdit}: a path that is unusable or is the document's own is
   * refused before anything is committed, a duplicate is committed once, and a
   * companion whose content the mirror already holds is dropped rather than
   * committed as an empty diff.
   */
  companionEdits?: CompanionEdit[];
  /** Called as each phase begins. Best-effort; see `makeStepReporter`. */
  onStep?: SaveStepListener;
  /**
   * Skips the Google Docs replica publish. For a caller that establishes the
   * document's own replica bookkeeping right after this returns (the Google Docs
   * import does, with `seedReplica`), the publish is at best a no-op on a path
   * that is not linked yet and at worst races the linking and files a
   * "apply this by hand" request for content the Doc already holds.
   */
  skipReplicaPublish?: boolean;
}): Promise<SaveDocumentResult> {
  const repoInfo = await getGithubRepo(params.workspaceId);
  if (!repoInfo) {
    throw new Error('No GitHub repository configured for workspace');
  }

  const documentUpdateService = DocumentUpdateService.getInstance();
  const githubService = GithubService.getInstance();
  const vectorStore = VectorStoreService.getInstance();
  const report = makeStepReporter(params.onStep);

  // Before anything is committed: an asset path is a repository path and a
  // mirror path at once, so one that escaped `assets/` would write wherever it
  // pointed — over a document, or outside the mirror root entirely.
  const assets = params.assets ?? [];
  for (const asset of assets) {
    assertSafeAssetPath(asset.path);
  }

  // Same rule, same moment, for the companions: their paths become tree entries
  // and mirror writes too, and one that is unusable has to be refused before a
  // commit rather than after it.
  const companions = await resolveCompanionEdits(params.workspaceId, params.filePath, params.companionEdits ?? []);

  // Capture pre-save content for the provenance diff before the mirror/index is
  // overwritten below. Look up by full path so nested docs (and siblings sharing
  // a basename) resolve to the correct entry.
  const editedFileName = params.filePath.split('/').pop() || params.filePath;
  const beforeContent = vectorStore.getMarkdownFile(params.filePath, params.workspaceId)?.content ?? '';

  const trimmedMessage = params.commitMessage.trim() || `Update ${params.filePath}`;

  // Manual web edit: provenance carries the manager + diff (no conversation),
  // and a `source` saying only that it was typed here — there is no thread or
  // Doc behind it. A creation lands here as 'new-file', where `beforeContent` is
  // already the empty string the type expects, because nothing was indexed under
  // the path; an import creates through the same path and adds where the
  // document came from on top of `editor`.
  const record: ProvenanceRecord = {
    version: 1,
    type: params.provenanceType ?? 'web-edit',
    file: { path: params.filePath, name: editedFileName },
    createdAt: new Date().toISOString(),
    updatedBy: { userId: params.userId },
    source: { editor: 'web', ...params.source },
    knowledge: '',
    messages: [],
    diff: { before: beforeContent, after: params.content },
  };
  // One record, for the document. The companions get no sidecar of their own:
  // the change being recorded is "this document was written, and these terms
  // came with it", and a second record under `.choir/context/GLOSSARY.md/`
  // would show the same manager making the same edit twice in the viewer's
  // history, with a diff nobody asked to review.
  const contextFile = await buildContextFile({
    workspaceId: params.workspaceId,
    docPath: params.filePath,
    record,
  });

  // Commit BEFORE touching the local mirror. The mirror is what the docs viewer
  // and Q&A read, so staging first meant a rejected push (no write access to the
  // repo, a protected branch, GitHub down) left CHOIR serving an edit that does
  // not exist on GitHub, with nothing to reconcile it. Nothing below the commit
  // needs the staged copy, so the remote write is the safe first step.
  report('committing');
  const { commitSha } = await githubService.commitFilesWithContext({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
    message: trimmedMessage,
    // files[0] is the document; the assets ride along so the markdown is never
    // committed pointing at images that are not there yet. Their bytes go as
    // base64 — committed as utf-8 they would land as literal base64 text.
    files: [
      { path: params.filePath, content: params.content },
      contextFile,
      ...assets.map((asset) => ({
        path: asset.path,
        content: asset.bytes.toString('base64'),
        encoding: 'base64' as const,
      })),
      // Last, so `files[0]` stays the document for everyone who reads the call.
      ...companions.map((companion) => ({ path: companion.path, content: companion.content })),
    ],
    workspaceId: params.workspaceId,
    userId: params.userId,
  });

  report('mirroring');
  await documentUpdateService.stageMarkdownUpdate({
    workspaceId: params.workspaceId,
    filePath: params.filePath,
    content: params.content,
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
  });
  await persistContextToMirror(params.workspaceId, contextFile);
  await writeAssetsToMirror(params.workspaceId, assets);
  await writeCompanionsToMirror(params.workspaceId, companions);

  await documentUpdateService.markGithubSyncSuccess({
    workspaceId: params.workspaceId,
    filePath: params.filePath,
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
    commitSha,
  });

  // Every file this commit wrote, document first. A companion is a document to
  // Q&A like any other — a glossary that answers "what does X mean?" is the
  // clearest case — so it is refreshed and published by the same rules.
  const savedFiles = [{ path: params.filePath, content: params.content }, ...companions];

  report('indexing');
  try {
    refreshIndexedFiles(vectorStore, params.workspaceId, repoInfo, savedFiles);
  } catch (error) {
    Logger.warn('saveEditedDocument: failed to refresh in-memory vector store entry', error as Error);
  }

  // The commit above is marked [choir-auto], so the GitHub webhook skips it and
  // the full-sync replica hook never runs for web edits. Publish here instead.
  if (!params.skipReplicaPublish) {
    for (const file of savedFiles) {
      schedulePublish({
        workspaceId: params.workspaceId,
        githubPath: file.path,
        markdown: file.content,
        reason: 'docs-editor-save',
      });
    }
  }

  scheduleQmdWarmup({
    workspaceId: params.workspaceId,
    reason: 'docs-editor-save',
  });

  // Caption any images in the saved document so they become searchable and get
  // a visible caption written back. Fire-and-forget — vision calls and the
  // follow-up commit must never block the save.
  void enrichWorkspaceImageCaptions(params.workspaceId, { userId: params.userId }).catch((error) => {
    Logger.warn('saveEditedDocument: image caption enrichment failed', error as Error);
  });

  Logger.info('saveEditedDocument: committed and indexed', {
    workspaceId: params.workspaceId,
    filePath: params.filePath,
    commitSha,
    companions: companions.map((companion) => companion.path),
    userId: params.userId,
  });

  return { commitSha };
}

/**
 * Puts the files this save wrote back into the in-memory store Q&A reads from.
 *
 * Extracted verbatim from the block that did this for the document alone: the
 * companions need exactly the same treatment, and doing them in one pass means
 * one `setLoadedMarkdownFiles` — a second call built from a list read before
 * the first one landed would drop whatever the first one added.
 */
function refreshIndexedFiles(
  vectorStore: ReturnType<typeof VectorStoreService.getInstance>,
  workspaceId: string,
  repoInfo: { owner: string; repo: string; branch?: string },
  files: Array<{ path: string; content: string }>,
): void {
  const branchSegment = repoInfo.branch || 'main';

  const updated: MarkdownFile[] = files.map(({ path: filePath, content }) => {
    const fileName = filePath.split('/').pop() || filePath;
    const existing = vectorStore.getMarkdownFile(filePath, workspaceId);
    const encodedPath = filePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    return {
      name: fileName,
      path: filePath,
      content,
      githubUrl:
        existing?.githubUrl ??
        `https://github.com/${repoInfo.owner}/${repoInfo.repo}/blob/${branchSegment}/${encodedPath}`,
      tree: parseMarkdownToTree(content, fileName),
    };
  });

  // De-dupe by full path so a sibling doc that merely shares a basename (e.g.
  // another README.md in a different folder) is not dropped from the in-memory
  // store.
  const written = new Set(updated.map((file) => file.path));
  const next = vectorStore.getAllMarkdownFiles(workspaceId).filter((file) => !written.has(file.path));
  next.push(...updated);
  vectorStore.setLoadedMarkdownFiles(next, workspaceId);
}

/**
 * The companion paths this save will actually commit.
 *
 * Runs before the commit, and refuses rather than drops: a caller that named an
 * unusable path (not markdown, outside the repository, inside `.choir/`) or the
 * document's own path has a bug, and committing the document while silently
 * losing the rows that were meant to travel with it is the one outcome this
 * whole option exists to prevent. What it does drop is a companion the mirror
 * already holds byte for byte — there is nothing to commit, and the commit
 * message would claim a change that is not in the diff.
 */
async function resolveCompanionEdits(
  workspaceId: string,
  documentPath: string,
  edits: CompanionEdit[],
): Promise<CompanionEdit[]> {
  if (edits.length === 0) return [];

  const ownPath = normalizeDocumentPath(documentPath) ?? documentPath;
  const resolved: CompanionEdit[] = [];
  const seen = new Set<string>();

  for (const edit of edits) {
    const normalized = normalizeDocumentPath(edit.path);
    if (!normalized) {
      throw new Error(`Refusing to commit a companion that is not a repository markdown path: ${edit.path}`);
    }
    if (normalized === ownPath) {
      throw new Error(`Refusing to commit a companion at the document's own path: ${normalized}`);
    }
    // Two edits to one file would make two tree entries for it, and GitHub
    // would keep whichever came last. The first wins, as it is written.
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    if (await isUnchanged(workspaceId, normalized, edit.content)) continue;
    resolved.push({ path: normalized, content: edit.content });
  }

  return resolved;
}

/**
 * Whether the mirror already holds exactly this content. A mirror that cannot
 * be read is answered `false`: committing a file whose blob is identical is a
 * no-op to GitHub, whereas skipping a change that was really there is a loss.
 */
async function isUnchanged(workspaceId: string, filePath: string, content: string): Promise<boolean> {
  try {
    return (await WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, filePath)) === content;
  } catch {
    return false;
  }
}

/**
 * Stages the companions in the mirror, beside the document.
 *
 * `writeMarkdownFile` rather than `stageMarkdownUpdate`: the file has just been
 * committed, so marking it dirty would queue a push of a change that is already
 * on GitHub. The section split and the path-map entry that come with this call
 * are what the viewer and QMD need to see it.
 */
async function writeCompanionsToMirror(workspaceId: string, companions: CompanionEdit[]): Promise<void> {
  if (companions.length === 0) return;

  const mirror = WorkspaceMirrorService.getInstance();
  for (const companion of companions) {
    await mirror.writeMarkdownFile(workspaceId, companion.path, companion.content);
  }
}

/**
 * Refuses an asset path that is not what this pipeline produces.
 *
 * Asset paths are content-addressed under `assets/` by the code that extracts
 * them, so this is not expected to fire — it is here because the same string is
 * used as a GitHub tree path and as a mirror path, and a `..` in it would write
 * outside the mirror. Throwing (rather than dropping the asset) runs before the
 * commit, so nothing lands half-done and the document never ships with a
 * reference to a file that was silently skipped.
 */
function assertSafeAssetPath(assetPath: string): void {
  const segments = assetPath.split('/');
  const safe =
    assetPath.length > 0 &&
    !path.isAbsolute(assetPath) &&
    segments[0] === 'assets' &&
    segments.length > 1 &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');

  if (!safe) {
    throw new Error(`Refusing to commit an asset outside assets/: ${assetPath}`);
  }
}

/**
 * Writes the assets into the workspace mirror, beside the markdown.
 *
 * The mirror is what the viewer serves images from, and the GitHub sync that
 * would otherwise bring them down runs on its own schedule. A path that is
 * already there is left alone: asset paths are content-addressed, so the file on
 * disk holds exactly these bytes. Committing it again is still correct — the
 * blob has the same sha, so the tree entry is unchanged and GitHub records no
 * modification for it.
 */
async function writeAssetsToMirror(workspaceId: string, assets: ImportAsset[]): Promise<void> {
  if (assets.length === 0) return;

  const repoRoot = WorkspaceMirrorService.getInstance().getRepoRoot(workspaceId);
  for (const asset of assets) {
    const absolute = path.join(repoRoot, asset.path);
    if (fs.existsSync(absolute)) continue;
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
    await fs.promises.writeFile(absolute, asset.bytes);
  }
}
