import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'services/common/logger';
import { GithubService } from 'services/github';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';

/** Image MIME types accepted for upload, mapped to their canonical file extension. */
export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** File extensions that the docs route should serve as binary image responses. */
export const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Directory (relative to the repo root) where uploaded assets are stored. */
export const ASSETS_DIR = 'assets';

/** Maximum accepted upload size. Mirrored by the route body-parser limit. */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export interface SaveAssetResult {
  /** Repo-root-relative path, e.g. `assets/<hash>.png`. Stored in the markdown. */
  path: string;
  /** True when a new GitHub commit was created (false when the asset already existed). */
  committed: boolean;
}

function extensionForContentType(contentType: string): string | null {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return ALLOWED_IMAGE_TYPES[normalized] ?? null;
}

/**
 * Persists an uploaded image: writes it into the workspace repo mirror so the
 * docs viewer can serve it immediately, then commits it to GitHub so it is
 * durable and survives the next mirror sync. Assets are content-addressed, so
 * uploading the same bytes twice resolves to the same path and skips the commit.
 */
export async function saveUploadedAsset(params: {
  workspaceId: string;
  userId: string;
  content: Buffer;
  contentType: string;
}): Promise<SaveAssetResult> {
  const ext = extensionForContentType(params.contentType);
  if (!ext) {
    throw new Error(`Unsupported image type: ${params.contentType || 'unknown'}`);
  }
  if (params.content.length === 0) {
    throw new Error('Uploaded file is empty');
  }
  if (params.content.length > MAX_ASSET_BYTES) {
    throw new Error(`File exceeds the ${Math.round(MAX_ASSET_BYTES / (1024 * 1024))}MB limit`);
  }

  const repoInfo = await getGithubRepo(params.workspaceId);
  if (!repoInfo) {
    throw new Error('No GitHub repository configured for workspace');
  }

  const hash = crypto.createHash('sha256').update(params.content).digest('hex').slice(0, 40);
  const relativePath = path.posix.join(ASSETS_DIR, `${hash}.${ext}`);

  const repoRoot = WorkspaceMirrorService.getInstance().getRepoRoot(params.workspaceId);
  const absolutePath = path.join(repoRoot, ASSETS_DIR, `${hash}.${ext}`);
  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
  if (!fs.existsSync(absolutePath)) {
    await fs.promises.writeFile(absolutePath, params.content);
  }

  const { created } = await GithubService.getInstance().uploadBinaryFile({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    path: relativePath,
    content: params.content,
    message: `Add image ${relativePath}`,
    branch: repoInfo.branch,
    workspaceId: params.workspaceId,
    userId: params.userId,
  });

  Logger.info('saveUploadedAsset: stored image asset', {
    workspaceId: params.workspaceId,
    path: relativePath,
    bytes: params.content.length,
    committed: created,
    userId: params.userId,
  });

  return { path: relativePath, committed: created };
}
