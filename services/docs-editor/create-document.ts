import { Logger } from 'services/common/logger';
import type { ProvenanceRecord } from 'services/document/provenance';
import type { ImportAsset } from 'services/import/types';
import { getGithubRepo } from 'services/slack';
import type { DocsApiErrorCode, DocsApiErrorDetail } from './api-errors';
import { documentExists } from './document-exists';
import { documentTitleFromPath, normalizeDocumentPath } from './document-path';
import { type CompanionEdit, type SaveStepListener, makeStepReporter, saveEditedDocument } from './save-document';

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
 * This is also where every import lands (PDF, a web page, a Google Doc): an
 * import is a new document whose content came from somewhere else, so it needs
 * the assets that travel with it in the same commit and a note in provenance of
 * where it came from, and nothing else about the landing differs. One landing
 * path rather than three is the point — the index refresh the Google Docs
 * import used to be missing comes with it.
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
  /** Images the content references; committed alongside it and mirrored. */
  assets?: ImportAsset[];
  /** Where the document came from, merged over `{ editor: 'web' }` in provenance. */
  source?: ProvenanceRecord['source'];
  /**
   * Existing or new markdown files that belong to this creation and land in the
   * same commit — the glossary rows a manager approved while importing the
   * document that taught them. See {@link CompanionEdit}; the overwrite check
   * above deliberately does not apply to them, because appending to a file that
   * is already there is the point.
   */
  companionEdits?: CompanionEdit[];
  /** Called as each phase begins. Best-effort: a listener that throws is ignored. */
  onStep?: SaveStepListener;
  /** See `saveEditedDocument`: for a caller that links the replica itself. */
  skipReplicaPublish?: boolean;
}): Promise<CreateDocumentResult> {
  const report = makeStepReporter(params.onStep);

  report('checking');
  const filePath = normalizeDocumentPath(params.filePath);
  if (!filePath) {
    throw new CreateDocumentRefusal(400, 'invalid_document_path');
  }

  const repoInfo = await getGithubRepo(params.workspaceId);
  if (!repoInfo) {
    throw new Error('No GitHub repository configured for workspace');
  }

  // Refuses to overwrite, and refuses BEFORE anything is committed: a creation
  // that landed on an existing path would file the replacement as a new file
  // with an empty `before`, which is the one way this operation could destroy
  // work. Rename makes the identical check, from the same helper.
  const occupied = await documentExists({
    workspaceId: params.workspaceId,
    userId: params.userId,
    filePath,
    repo: repoInfo,
  });

  if (occupied) {
    throw new CreateDocumentRefusal(409, 'document_exists', { path: filePath });
  }

  // An empty document has nothing to open onto, so it starts as its own title.
  const content = params.content?.trim() ? params.content : `# ${documentTitleFromPath(filePath)}\n`;

  // 'committing', 'mirroring' and 'indexing' are reported from inside the save,
  // which is where those phases actually happen.
  const { commitSha } = await saveEditedDocument({
    workspaceId: params.workspaceId,
    userId: params.userId,
    filePath,
    content,
    commitMessage: params.commitMessage?.trim() || `Create ${filePath}`,
    provenanceType: 'new-file',
    assets: params.assets,
    source: params.source,
    companionEdits: params.companionEdits,
    onStep: params.onStep,
    skipReplicaPublish: params.skipReplicaPublish,
  });

  Logger.info('createDocument: created document', {
    workspaceId: params.workspaceId,
    filePath,
    commitSha,
    assetCount: params.assets?.length ?? 0,
    companionCount: params.companionEdits?.length ?? 0,
    userId: params.userId,
  });

  report('done');
  return { commitSha, filePath };
}
