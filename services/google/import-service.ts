import path from 'node:path';
import { CreateDocumentRefusal, createDocument } from 'services/docs-editor/create-document';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { linkDescription, stripBanner } from './banner';
import { exportDocMarkdown, getDocMeta } from './drive-client';
import { type RejectedAsset, assetRepoPath, extractImportable } from './gdocs-delta';
import { getWorkspaceClient } from './google-auth-service';
import { normalizeImportPath } from './import-path';
import { type ImportProgress, makeProgressReporter } from './import-steps';
import { bannerLanguage, seedReplica } from './replica-publisher';

export { IMPORT_STEPS, type ImportProgress, type ImportStep } from './import-steps';

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
  /** Called as each step begins. Never throws into the import: errors are swallowed. */
  onProgress?: (progress: ImportProgress) => void;
}): Promise<ImportResult> {
  const { workspaceId, fileId, userId } = params;

  const report = makeProgressReporter(params.onProgress);
  report('checking');

  // The landing checks the path again, authoritatively (mirror, disk, and
  // GitHub itself). These three run first anyway so an unusable path, an
  // unconfigured workspace or an occupied path fails without exporting a Doc —
  // a Drive round trip and, for a long document, a slow one.
  const githubPath = normalizeImportPath(params.githubPath);
  if (!githubPath) {
    return { outcome: 'invalid-path', detail: 'Give a repository-relative path ending in .md' };
  }

  if (!(await getGithubRepo(workspaceId))) {
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
    report('reading');
    const meta = await getDocMeta(client, fileId);
    if (meta.trashed) {
      return { outcome: 'failed', detail: 'That document is in the trash' };
    }

    // A Doc that is already somebody's replica carries the banner; importing it
    // should not commit the banner as if it were part of the text.
    //
    // The raw export is kept as well as the stripped body: it becomes the sync
    // baseline, and the baseline has to be what the document actually exports,
    // not a version of it we edited on the way past.
    const rawExport = await exportDocMarkdown(client, fileId);
    const exported = stripBanner(rawExport);
    const extraction = extractImportable(exported.body);

    if (!extraction.markdown.trim()) {
      return { outcome: 'empty', detail: 'That document exported as empty' };
    }

    // The landing — commit, mirror, index, provenance — is the viewer's "new
    // document" path, shared with the PDF and URL imports so there is one way a
    // document is born. What the import used to do by hand here it gets from
    // there, including the vector-store refresh and QMD warmup it was missing.
    //
    // It writes a 'new-file' provenance sidecar, which this path used to refuse:
    // the objection was that the viewer rendered every record as a whole-file
    // change list, so a record for an import read as the document restating
    // itself. With 'new-file' the viewer renders a creation instead, and the
    // sidecar earns its place by carrying `source` — which Doc this came from,
    // in the same field the PDF and URL imports use.
    //
    // The replica publish is skipped: this document is linked in `preserve` mode
    // a few lines below, and a publish racing that linking would file a
    // "apply this by hand" request for content the Doc already holds.
    const { commitSha } = await createDocument({
      workspaceId,
      userId,
      filePath: githubPath,
      content: extraction.markdown,
      commitMessage: `Import ${path.posix.basename(githubPath)} from Google Docs (${meta.name ?? fileId})`,
      assets: extraction.assets.map((asset) => ({
        path: assetRepoPath(asset),
        bytes: asset.bytes,
        contentType: asset.contentType,
      })),
      source: {
        import: 'google-docs',
        name: meta.name ?? fileId,
        url: meta.webViewLink,
        fileId,
      },
      onStep: (step) => {
        // The import's own vocabulary is narrower: it reports `checking` and
        // `done` itself around the whole operation, and the viewer's step
        // catalog has no `indexing` label. Only the overlap is forwarded.
        if (step === 'committing' || step === 'mirroring') report(step);
      },
      skipReplicaPublish: true,
    });

    // Link it, so edits made in the Doc from here on come back through review.
    //
    // Nothing is written to the document. It was somebody's document before it
    // was ours, and publishing the round-tripped markdown back over it — which is
    // what this step used to do — replaced its fonts, its alignment, its page
    // layout and the size of its images with whatever Drive renders markdown as.
    // The sync bookkeeping is instead seeded from the export we just read, which
    // is the same pair a publish would have recorded, minus the damage.
    report('linking');
    let linked = false;
    try {
      await new WorkspaceStore().setGoogleDocMapping(workspaceId, githubPath, {
        fileId,
        webViewLink: meta.webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`,
        linkedBy: userId,
        mode: 'preserve',
      });
      const seeded = await seedReplica({
        workspaceId,
        githubPath,
        markdown: extraction.markdown,
        baseline: rawExport,
        description: linkDescription(await bannerLanguage(workspaceId, extraction.markdown)),
      });
      // 'seeded-drifted' counts as linked: the bookkeeping is in place and the
      // difference is a human edit the poller will raise for review.
      linked = seeded.outcome === 'seeded' || seeded.outcome === 'seeded-drifted';
    } catch {
      linked = false;
    }

    report('done');
    return {
      outcome: 'imported',
      githubPath,
      commitSha,
      webViewLink: meta.webViewLink,
      linked,
      rejectedAssets: extraction.rejected.length ? extraction.rejected : undefined,
    };
  } catch (error) {
    // The landing's refusals are this import's own vocabulary under another
    // name: the path is unusable, or something is already there. They are
    // answers the manager can act on, not failures, and the route and the viewer
    // already speak these two outcomes.
    if (error instanceof CreateDocumentRefusal) {
      if (error.apiCode === 'document_exists') {
        return { outcome: 'exists', githubPath, detail: `${githubPath} already exists in this repository` };
      }
      return { outcome: 'invalid-path', detail: 'Give a repository-relative path ending in .md' };
    }
    return { outcome: 'failed', detail: (error as Error).message };
  }
}
