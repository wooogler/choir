/**
 * Which folder a conversation's document updates belong in.
 *
 * A Slack channel that belongs to a project folder with `scope.updates ===
 * 'folder'` says, by the act of having been declared, "what is discussed here
 * is documented here" (docs/project-folders.md 4). This module turns that
 * declaration into the one thing the update flow needs: a repository-relative
 * folder prefix, or `null` for the workspace-wide behaviour CHOIR has always
 * had.
 *
 * It lives next to the update flow rather than in `services/projects` because
 * the project index knows nothing about candidate searches: the mapping from
 * channel to prefix is an update-flow policy, and keeping it here means the
 * index stays a pure read of the repository.
 */

import { Logger } from 'services/common/logger';
import { type ProjectRecord, resolveProjectForChannel } from 'services/projects/project-index';

export interface UpdateScope {
  /** Repository-relative folder (no trailing slash), or null for the whole workspace. */
  folderPrefix: string | null;
  /** The project the channel belongs to, even when its updates are workspace-wide. */
  project: ProjectRecord | null;
}

const WORKSPACE_WIDE: UpdateScope = { folderPrefix: null, project: null };

/**
 * The update scope for a conversation.
 *
 * Never throws: a mirror that has not synced yet, or a project file somebody
 * broke by hand, must not take the review flow down with it — the honest
 * fallback is the workspace-wide search this feature is narrowing.
 */
export async function resolveUpdateScope(
  workspaceId: string,
  channelId: string | null | undefined,
): Promise<UpdateScope> {
  if (!channelId) return WORKSPACE_WIDE;

  try {
    const project = await resolveProjectForChannel(workspaceId, channelId);
    if (!project) return WORKSPACE_WIDE;

    return {
      folderPrefix: project.settings.scope.updates === 'folder' ? project.folder : null,
      project,
    };
  } catch (error) {
    Logger.warn('Could not resolve the update scope for a channel; falling back to the whole workspace', {
      workspaceId,
      channelId,
      error: String(error),
    });
    return WORKSPACE_WIDE;
  }
}

/** Whether a document path sits inside `folderPrefix`. The folder itself is not a document. */
export function isUnderFolder(docPath: string | null | undefined, folderPrefix: string): boolean {
  if (!docPath) return false;

  const prefix = folderPrefix.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!prefix) return true;

  const normalized = docPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return normalized.startsWith(`${prefix}/`);
}

export interface FolderScopedSearch<T> {
  results: T[];
  /** True when the folder held nothing and the search was redone workspace-wide. */
  widened: boolean;
}

/**
 * Runs a candidate search inside the project folder and, when that finds
 * nothing, again across the whole repository.
 *
 * The widening is reported rather than hidden: a manager who declared a project
 * folder and is then shown a document from outside it deserves the one line
 * that explains why (docs/project-folders.md 3, which asks for the same notice
 * on the Q&A side).
 */
export async function searchWithFolderFallback<T>(params: {
  folderPrefix: string | null;
  search: (folderPrefix: string | null) => Promise<T[]>;
}): Promise<FolderScopedSearch<T>> {
  if (!params.folderPrefix) {
    return { results: await params.search(null), widened: false };
  }

  const scoped = await params.search(params.folderPrefix);
  if (scoped.length > 0) return { results: scoped, widened: false };

  return { results: await params.search(null), widened: true };
}

/**
 * Where a newly created document should land: inside the project folder, unless
 * the generated name already names a folder inside it.
 *
 * Only the leading folder is added — the generator returns a bare basename, and
 * a name that already carries a path is the caller's own choice to respect.
 */
export function prefixNewFilePath(folderPrefix: string | null, fileName: string): string {
  const name = fileName.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  if (!folderPrefix || !name) return name;
  if (isUnderFolder(name, folderPrefix)) return name;
  return `${folderPrefix.replace(/\/+$/, '')}/${name}`;
}
