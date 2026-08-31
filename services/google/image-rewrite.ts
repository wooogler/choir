import fs from 'node:fs';
import path from 'node:path';
import { signImageToken } from 'services/docs-editor/image-token';
import { classifyImageSrc, resolveLocalImageRepoPath, rewriteImageSrcs } from 'services/document/image-refs';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';

/**
 * Turns repo-relative image references into URLs Drive can fetch.
 *
 * Drive downloads images server-side while converting the upload, so a path like
 * `./images/a.png` becomes a broken image in the replica. Local images are
 * exposed through the public docs asset route with a path-scoped signed token —
 * the route is otherwise session-authenticated, and Drive arrives without a
 * cookie. The token's lifetime does not matter: Drive embeds a *copy* at import
 * time and never fetches the URL again.
 *
 * Images that cannot be resolved are dropped rather than left to render as a
 * broken-image placeholder in a document people are meant to read.
 */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export function rewriteImagesForDrive(workspaceId: string, docRelPath: string, markdown: string): string {
  const baseUrl = process.env.DOCS_BASE_URL?.replace(/\/$/, '');
  const repoRoot = WorkspaceMirrorService.getInstance().getRepoRoot(workspaceId);
  const repoRootResolved = path.resolve(repoRoot);

  return rewriteImageSrcs(markdown, (src) => {
    const kind = classifyImageSrc(src);

    // Remote images are already fetchable; data URLs are embedded as-is.
    if (kind === 'remote' || kind === 'data') {
      return src;
    }
    // Without a public base URL there is no address Drive could reach.
    if (!baseUrl) {
      return null;
    }

    const repoPath = resolveLocalImageRepoPath(docRelPath, src);
    if (!repoPath || !IMAGE_EXTENSIONS.has(path.posix.extname(repoPath).slice(1).toLowerCase())) {
      return null;
    }

    const absolute = path.resolve(repoRootResolved, repoPath);
    if (!absolute.startsWith(`${repoRootResolved}${path.sep}`) || !fs.existsSync(absolute)) {
      return null;
    }

    const encoded = repoPath.split('/').map(encodeURIComponent).join('/');
    const token = signImageToken(workspaceId, repoPath);
    return `${baseUrl}/api/docs/${encodeURIComponent(workspaceId)}/${encoded}?token=${encodeURIComponent(token)}`;
  });
}
