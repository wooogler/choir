import path from 'node:path';
import { Logger } from 'services/common/logger';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { createDocFromMarkdown, shareByLink } from './drive-client';
import { getWorkspaceClient } from './google-auth-service';
import { type PublishOutcome, publishReplica } from './replica-publisher';

/**
 * Publishes a repository document as a brand-new Google Doc and links the two.
 *
 * The other way to get a replica is the link route, which needs an existing Doc
 * picked through the Picker and then replaces its content. That suits a Doc
 * somebody already shares around; for a document that has never been in Google
 * Docs, asking them to create an empty one first is a detour. This creates it.
 *
 * Everything after the creation is the ordinary replica path. The mapping is
 * `replica` because the Doc has no formatting of its own to preserve yet, and
 * `publishReplica` writes the banner, records the baseline and leaves the
 * document `synced`, exactly as a picked link would.
 *
 * The Doc belongs to the workspace's connected Google account. So that the
 * people reading it in Slack can actually open it, it is shared read-only with
 * anyone holding the link. Best effort: a sharing failure is reported but does
 * not undo a document that was created and linked correctly.
 */

export type PublishNewDocOutcome =
  | 'created'
  /** This repository path already has a Google Doc. */
  | 'already-linked'
  | 'missing-in-repo'
  | 'not-connected'
  | 'failed';

export interface PublishNewDocResult {
  outcome: PublishNewDocOutcome;
  fileId?: string;
  webViewLink?: string;
  /** What the first publish into the new Doc did. */
  published?: PublishOutcome;
  /** False when the link-sharing grant failed; the Doc is still private to the account. */
  shared?: boolean;
  detail?: string;
}

/** The first `# ` heading, which is the document's own title when it has one. */
function firstHeading(markdown: string): string | undefined {
  const match = markdown.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
  return match ? match[1].trim() : undefined;
}

/** What the Doc is called in Drive: the document's title, else its file name. */
export function docNameFor(githubPath: string, markdown: string): string {
  return firstHeading(markdown) || path.posix.basename(githubPath).replace(/\.md$/i, '');
}

export async function publishAsNewDoc(params: {
  workspaceId: string;
  githubPath: string;
  userId: string;
}): Promise<PublishNewDocResult> {
  const { workspaceId, githubPath, userId } = params;
  const store = new WorkspaceStore();

  // Cheapest refusals first, and all of them before anything reaches Drive.
  if (await store.getGoogleDocMapping(workspaceId, githubPath)) {
    return { outcome: 'already-linked' };
  }

  const markdown = await WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, githubPath);
  if (markdown === null) {
    return { outcome: 'missing-in-repo' };
  }

  const client = await getWorkspaceClient(workspaceId);
  if (!client) {
    return { outcome: 'not-connected' };
  }

  let fileId: string;
  let webViewLink: string;
  try {
    // Created with the repository text so the Doc is never seen empty, even if
    // the publish below is what establishes the baseline.
    const created = await createDocFromMarkdown(client, { name: docNameFor(githubPath, markdown), markdown });
    fileId = created.fileId;
    webViewLink = created.webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`;
  } catch (error) {
    Logger.error(`Could not create a Google Doc for ${githubPath}`, error as Error, { workspaceId });
    return { outcome: 'failed', detail: (error as Error).message };
  }

  let shared = true;
  try {
    await shareByLink(client, fileId);
  } catch (error) {
    shared = false;
    Logger.warn('Created a Google Doc but could not share it by link', {
      workspaceId,
      githubPath,
      fileId,
      error: (error as Error).message,
    });
  }

  try {
    await store.setGoogleDocMapping(workspaceId, githubPath, {
      fileId,
      webViewLink,
      linkedBy: userId,
      mode: 'replica',
    });
  } catch (error) {
    // The Doc exists but nothing points at it. Hand back the link so the manager
    // can find and delete it rather than leaving an unexplained file in Drive.
    Logger.error(`Created a Google Doc for ${githubPath} but could not link it`, error as Error, { workspaceId });
    return { outcome: 'failed', fileId, webViewLink, shared, detail: (error as Error).message };
  }

  // Force: a fresh mapping has no recorded hash or state, and this write is what
  // puts the banner in and records the baseline the poller will compare against.
  const published = await publishReplica({ workspaceId, githubPath, markdown, force: true });

  return { outcome: 'created', fileId, webViewLink, published: published.outcome, shared };
}
