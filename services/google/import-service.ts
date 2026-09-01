import fs from 'node:fs';
import path from 'node:path';
import { GithubService } from 'services/github';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { stripBanner } from './banner';
import { exportDocMarkdown, getDocMeta } from './drive-client';
import { type RejectedAsset, assetRepoPath, extractImportable } from './gdocs-delta';
import { getWorkspaceClient } from './google-auth-service';
import { normalizeImportPath } from './import-path';
import { publishReplica } from './replica-publisher';

/**
 * Brings an existing Google Doc into the repository as a new markdown document.
 *
 * This is the opposite direction from `replica-publisher`, and the only place
 * content ever travels Docs → GitHub without a review: there is nothing to
 * review, because the document does not exist in the repository yet. Once it
 * lands it is linked as a replica, so every later edit in Docs goes through the
 * ordinary drift-and-review path.
 *
 * Refuses to overwrite. An import that lands on an existing path would be a
 * silent, unreviewed replacement of a document someone else wrote.
 */

export type ImportOutcome =
  | 'imported'
  /** Something already lives at that repository path. */
  | 'exists'
  | 'invalid-path'
  /** The Doc exported to nothing but whitespace. */
  | 'empty'
  | 'not-connected'
  | 'failed';

export interface ImportResult {
  outcome: ImportOutcome;
  githubPath?: string;
  commitSha?: string;
  webViewLink?: string;
  /** False when the document was committed but linking it as a replica failed. */
  linked?: boolean;
  rejectedAssets?: RejectedAsset[];
  detail?: string;
}

export async function importGoogleDoc(params: {
  workspaceId: string;
  githubPath: string;
  fileId: string;
  userId: string;
}): Promise<ImportResult> {
  const { workspaceId, fileId, userId } = params;

  const githubPath = normalizeImportPath(params.githubPath);
  if (!githubPath) {
    return { outcome: 'invalid-path', detail: 'Give a repository-relative path ending in .md' };
  }

  const repoInfo = await getGithubRepo(workspaceId);
  if (!repoInfo) {
    return { outcome: 'failed', detail: 'No GitHub repository configured for this workspace' };
  }

  const mirror = WorkspaceMirrorService.getInstance();
  if ((await mirror.readMirrorFile(workspaceId, githubPath)) !== null) {
    return { outcome: 'exists', githubPath, detail: `${githubPath} already exists in this repository` };
  }

  const client = await getWorkspaceClient(workspaceId);
  if (!client) {
    return { outcome: 'not-connected' };
  }

  try {
    const meta = await getDocMeta(client, fileId);
    if (meta.trashed) {
      return { outcome: 'failed', detail: 'That document is in the trash' };
    }

    // A Doc that is already somebody's replica carries the banner; importing it
    // should not commit the banner as if it were part of the text.
    const exported = stripBanner(await exportDocMarkdown(client, fileId));
    const extraction = extractImportable(exported.body);

    if (!extraction.markdown.trim()) {
      return { outcome: 'empty', detail: 'That document exported as empty' };
    }

    // No provenance sidecar. A record is the *why* behind a change — the other
    // new-file path carries the extracted knowledge and the conversation it came
    // from — and an import has none of that: it would be an empty `knowledge`,
    // no `messages`, and a `diff.after` holding a second encrypted copy of the
    // document, which the viewer then renders as a change list restating the
    // whole file. Where it came from is already on the commit message and in the
    // Google Doc mapping. Documents with no records are an ordinary state:
    // readRecords returns [] for a missing directory.
    const { commitSha } = await GithubService.getInstance().commitFilesWithContext({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      branch: repoInfo.branch,
      message: `Import ${path.posix.basename(githubPath)} from Google Docs (${meta.name ?? fileId})`,
      files: [
        { path: githubPath, content: extraction.markdown },
        ...extraction.assets.map((asset) => ({
          path: assetRepoPath(asset),
          content: asset.bytes.toString('base64'),
          encoding: 'base64' as const,
        })),
      ],
      workspaceId,
      userId,
    });

    // The mirror is what the viewer reads, and the GitHub sync that would
    // otherwise refresh it runs on its own schedule.
    await mirror.writeMarkdownFile(workspaceId, githubPath, extraction.markdown);
    const repoRoot = mirror.getRepoRoot(workspaceId);
    for (const asset of extraction.assets) {
      const absolute = path.join(repoRoot, assetRepoPath(asset));
      await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
      await fs.promises.writeFile(absolute, asset.bytes);
    }

    // Link it, so from here on this is an ordinary replica: GitHub changes push
    // into the Doc, and edits made in the Doc come back through review.
    let linked = false;
    try {
      await new WorkspaceStore().setGoogleDocMapping(workspaceId, githubPath, {
        fileId,
        webViewLink: meta.webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`,
        linkedBy: userId,
      });
      // Force: nothing has been recorded for this document yet, and the Doc has
      // to carry the banner and the round-tripped text from now on.
      const published = await publishReplica({
        workspaceId,
        githubPath,
        markdown: extraction.markdown,
        force: true,
      });
      linked = published.outcome === 'published';
    } catch {
      linked = false;
    }

    return {
      outcome: 'imported',
      githubPath,
      commitSha,
      webViewLink: meta.webViewLink,
      linked,
      rejectedAssets: extraction.rejected.length ? extraction.rejected : undefined,
    };
  } catch (error) {
    return { outcome: 'failed', detail: (error as Error).message };
  }
}
