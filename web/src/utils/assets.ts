import { type ServerErrorPayload, type T, describeServerError } from '../i18n';
import { encodePath } from './docs';

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i; // http://, https://, protocol-relative //
const DATA_OR_BLOB = /^(?:data|blob):/i;

/**
 * Uploads an image to the workspace and returns its repo-root-relative path
 * (e.g. `assets/<hash>.png`). The server stores the bytes in the mirror and
 * commits them to GitHub.
 *
 * Takes the caller's translator rather than reading context: this runs inside a
 * Crepe upload callback, which is not a React render.
 */
export async function uploadAsset(workspaceId: string, file: File, t: T): Promise<string> {
  const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/assets`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as ServerErrorPayload;
    throw new Error(describeServerError(t, data) ?? t('assets.error.upload', { status: response.status }));
  }

  const data = (await response.json()) as { path?: string };
  if (!data.path) {
    throw new Error(t('assets.error.missingPath'));
  }
  return data.path;
}

function docDirectory(docFilePath: string): string {
  const index = docFilePath.lastIndexOf('/');
  return index >= 0 ? docFilePath.slice(0, index) : '';
}

/**
 * Converts a repo-root-relative asset path (`assets/<hash>.png`) into a path
 * relative to the current document, so committed markdown renders correctly
 * both in the CHOIR viewer and on GitHub regardless of where the doc lives.
 */
export function toDocRelativeAssetPath(docFilePath: string, repoRelativeAsset: string): string {
  const fromParts = docDirectory(docFilePath).split('/').filter(Boolean);
  const toParts = repoRelativeAsset.split('/').filter(Boolean);

  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common += 1;
  }

  const ups = fromParts.slice(common).map(() => '..');
  const downs = toParts.slice(common);
  const relative = [...ups, ...downs].join('/');
  return relative || repoRelativeAsset;
}

/**
 * Resolves an image `src` from the markdown into a URL the browser can load.
 * Absolute / data / blob URLs pass through unchanged; repo-relative paths are
 * resolved against the document's directory and served from the workspace
 * mirror via the docs API.
 */
export function resolveAssetDisplayUrl(workspaceId: string, docFilePath: string, src: string): string {
  if (!src || ABSOLUTE_URL.test(src) || DATA_OR_BLOB.test(src)) {
    return src;
  }

  const dir = docDirectory(docFilePath);
  const base = `http://docs.local/${dir ? `${dir}/` : ''}`;
  const resolved = new URL(src, base).pathname.replace(/^\/+/, '');
  if (!resolved) {
    return src;
  }
  return `/api/docs/${encodeURIComponent(workspaceId)}/${encodePath(resolved)}`;
}
