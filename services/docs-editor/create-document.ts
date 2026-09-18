import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'services/common/logger';
import { GithubService } from 'services/github';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import type { DocsApiErrorCode, DocsApiErrorDetail } from './api-errors';
import { documentTitleFromPath, normalizeDocumentPath } from './document-path';
import { saveEditedDocument } from './save-document';

export interface CreateDocumentResult {
  commitSha: string;
  /** The normalized path the document was committed to, which may differ from the one asked for. */
  filePath: string;
}

/**
 * A refusal the caller can answer with as-is.
 *
 * Neither case below is a fault: the path is unusable, or something already
 * lives there. Both are answers the manager can act on, so they carry the API
 * code and status that say which, rather than arriving at the route as an
 * opaque 500.
 */
export class CreateDocumentRefusal extends Error {
  readonly status: number;
  readonly apiCode: DocsApiErrorCode;
  readonly detail?: DocsApiErrorDetail;

  constructor(status: number, apiCode: DocsApiErrorCode, detail?: DocsApiErrorDetail) {
    super(apiCode);
    this.name = 'CreateDocumentRefusal';
    this.status = status;
    this.apiCode = apiCode;
    this.detail = detail;
  }
}

/**
 * Creates a new markdown document from the docs viewer.
 *
 * Everything after the checks is an ordinary save: the same commit, provenance
 * sidecar, mirror staging, path map, index refresh and replica publish an edit
 * goes through, so a document born here is indistinguishable from one edited
 * here. Only the provenance type differs — the viewer calls it a new file.
 *
 * Refuses to overwrite, and refuses BEFORE anything is committed. A creation
 * that landed on an existing path would be a silent, unreviewed replacement of
 * a document someone else wrote; the manager meant to start a new one.
 */
export async function createDocument(params: {
  workspaceId: string;
  userId: string;
  filePath: string;
  content?: string;
  commitMessage?: string;
}): Promise<CreateDocumentResult> {
  const filePath = normalizeDocumentPath(params.filePath);
  if (!filePath) {
    throw new CreateDocumentRefusal(400, 'invalid_document_path');
  }

  const repoInfo = await getGithubRepo(params.workspaceId);
  if (!repoInfo) {
    throw new Error('No GitHub repository configured for workspace');
  }

  const mirror = WorkspaceMirrorService.getInstance();
  const repoRoot = mirror.getRepoRoot(params.workspaceId);
  // `fs.existsSync` before `readMirrorFile`, deliberately: the mirror read only
  // forgives ENOENT, so a directory (or an unreadable file) named `foo.md` would
  // throw EISDIR out of here and the route would answer 500 for what is plainly
  // an occupied path.
  const occupiedLocally =
    fs.existsSync(path.join(repoRoot, filePath)) || (await mirrorHolds(params.workspaceId, filePath));

  // The mirror is a cache, not the repository. A fresh install has not synced
  // yet, a push webhook can be missed, and a document committed to GitHub
  // minutes ago may not be on disk at all — so the only honest "is this path
  // free?" comes from GitHub. Skipping it would let a create silently replace
  // somebody's document and file the replacement as a new file with an empty
  // `before`, which is the one way this operation could destroy work.
  //
  // Check-then-commit is not atomic: two managers creating the same path at the
  // same moment can still collide. That is accepted — this route is manager-only
  // and the loser's content survives in the commit history either way.
  const occupied =
    occupiedLocally ||
    (await GithubService.getInstance().getFile({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      path: filePath,
      branch: repoInfo.branch,
      workspaceId: params.workspaceId,
      userId: params.userId,
    })) !== null;

  if (occupied) {
    throw new CreateDocumentRefusal(409, 'document_exists', { path: filePath });
  }

  // An empty document has nothing to open onto, so it starts as its own title.
  const content = params.content?.trim() ? params.content : `# ${documentTitleFromPath(filePath)}\n`;

  const { commitSha } = await saveEditedDocument({
    workspaceId: params.workspaceId,
    userId: params.userId,
    filePath,
    content,
    commitMessage: params.commitMessage?.trim() || `Create ${filePath}`,
    provenanceType: 'new-file',
  });

  Logger.info('createDocument: created document', {
    workspaceId: params.workspaceId,
    filePath,
    commitSha,
    userId: params.userId,
  });

  return { commitSha, filePath };
}

/**
 * Whether the mirror holds anything at this path.
 *
 * A read that fails for any reason other than "not there" counts as occupied:
 * a path CHOIR cannot look at is not a path it should commit over.
 */
async function mirrorHolds(workspaceId: string, filePath: string): Promise<boolean> {
  try {
    return (await WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, filePath)) !== null;
  } catch {
    return true;
  }
}
