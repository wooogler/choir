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

export interface SaveDocumentResult {
  commitSha: string;
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

  await documentUpdateService.markGithubSyncSuccess({
    workspaceId: params.workspaceId,
    filePath: params.filePath,
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
    commitSha,
  });

  report('indexing');
  try {
    const fileName = params.filePath.split('/').pop() || params.filePath;
    const tree = parseMarkdownToTree(params.content, fileName);
    const existing = vectorStore.getMarkdownFile(params.filePath, params.workspaceId);
    const branchSegment = repoInfo.branch || 'main';
    const encodedPath = params.filePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const githubUrl =
      existing?.githubUrl ??
      `https://github.com/${repoInfo.owner}/${repoInfo.repo}/blob/${branchSegment}/${encodedPath}`;

    const allFiles = vectorStore.getAllMarkdownFiles(params.workspaceId);
    const updatedFile: MarkdownFile = {
      name: fileName,
      path: params.filePath,
      content: params.content,
      githubUrl,
      tree,
    };
    // De-dupe by full path so a sibling doc that merely shares this basename
    // (e.g. another README.md in a different folder) is not dropped from the
    // in-memory store.
    const next = allFiles.filter((file) => file.path !== params.filePath);
    next.push(updatedFile);
    vectorStore.setLoadedMarkdownFiles(next, params.workspaceId);
  } catch (error) {
    Logger.warn('saveEditedDocument: failed to refresh in-memory vector store entry', error as Error);
  }

  // The commit above is marked [choir-auto], so the GitHub webhook skips it and
  // the full-sync replica hook never runs for web edits. Publish here instead.
  if (!params.skipReplicaPublish) {
    schedulePublish({
      workspaceId: params.workspaceId,
      githubPath: params.filePath,
      markdown: params.content,
      reason: 'docs-editor-save',
    });
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
    userId: params.userId,
  });

  return { commitSha };
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
