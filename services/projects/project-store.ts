import { Logger } from 'services/common/logger';
import { GithubService } from 'services/github';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { type ProjectRecord, getProjectIndex, invalidateProjectIndex } from './project-index';
import { ProjectRefusal } from './refusal';
import { PROJECT_FILE, normalizeProjectFolder, parseProjectSettings, serializeProjectSettings } from './schema';

/**
 * Writing a folder's `.choir/project.json`.
 *
 * Deliberately NOT the viewer's document save path (docs/project-folders.md 7):
 * this is configuration, not a document, so provenance, the QMD index, the
 * section split and the Google replica are all irrelevant to it. What is left is
 * exactly two things — a commit, and the mirror copy the index reads back.
 */

// Re-exported so a caller that reaches for the store's refusals finds them here.
export { ProjectRefusal };

export interface SaveProjectResult {
  commitSha: string;
  project: ProjectRecord;
}

/** Where a project's metadata file lives, repository-relative. */
export function projectFilePath(folder: string): string {
  return `${folder}/${PROJECT_FILE}`;
}

/**
 * Creates or updates a project. Both are the same commit: the Git Data API
 * writes a blob at a path whether or not one was there, so there is no "does it
 * exist yet" round-trip to make and no window between the two.
 */
export async function saveProject(params: {
  workspaceId: string;
  userId: string;
  folder: string;
  /** The settings object from the GUI; validated here, not by the caller. */
  settings: unknown;
}): Promise<SaveProjectResult> {
  const folder = normalizeProjectFolder(params.folder);
  if (!folder) {
    throw new ProjectRefusal(400, 'project_folder_invalid', { folder: String(params.folder) });
  }

  const parsed = parseProjectSettings(params.settings);
  if (!parsed.ok) {
    throw new ProjectRefusal(400, 'project_invalid', { message: parsed.message });
  }

  // One channel belongs to one project (docs/project-folders.md 2). The GUI
  // greys out a taken channel, but the GUI is not the fence: two managers with
  // two dialogs open would otherwise both link the same channel and the answer
  // would depend on which folder the index happened to walk first.
  const index = await getProjectIndex(params.workspaceId);
  for (const channel of parsed.value.channels) {
    const owner = index.byChannel.get(channel);
    if (owner && owner !== folder) {
      throw new ProjectRefusal(409, 'project_channel_taken', { channel, folder: owner });
    }
  }

  const repoInfo = await getGithubRepo(params.workspaceId);
  if (!repoInfo) {
    throw new Error('No GitHub repository configured for workspace');
  }

  const filePath = projectFilePath(folder);
  const content = serializeProjectSettings(parsed.value);

  const { commitSha } = await GithubService.getInstance().commitFilesWithContext({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
    message: `Update project settings: ${folder}`,
    files: [{ path: filePath, content }],
    workspaceId: params.workspaceId,
    userId: params.userId,
  });

  // The mirror is what the index walks, so it has to carry the new file before
  // the invalidation below — otherwise the next read rebuilds from the old one
  // and the manager's save looks like it did nothing until the next sync.
  await WorkspaceMirrorService.getInstance().writeContextFile(params.workspaceId, filePath, content);
  invalidateProjectIndex(params.workspaceId);

  Logger.info('Saved project settings', {
    workspaceId: params.workspaceId,
    folder,
    channels: parsed.value.channels.length,
    commitSha,
    userId: params.userId,
  });

  return { commitSha, project: { folder, settings: parsed.value } };
}

/**
 * Unmakes a project: the folder and its documents stay, only the metadata goes.
 * Questions from its channels go back to searching the whole repository.
 */
export async function deleteProject(params: {
  workspaceId: string;
  userId: string;
  folder: string;
}): Promise<{ commitSha: string; folder: string }> {
  const folder = normalizeProjectFolder(params.folder);
  if (!folder) {
    throw new ProjectRefusal(400, 'project_folder_invalid', { folder: String(params.folder) });
  }

  const index = await getProjectIndex(params.workspaceId);
  const known = index.byFolder.has(folder) || index.broken.some((entry) => entry.folder === folder);
  if (!known) {
    throw new ProjectRefusal(404, 'project_not_found', { folder });
  }

  const repoInfo = await getGithubRepo(params.workspaceId);
  if (!repoInfo) {
    throw new Error('No GitHub repository configured for workspace');
  }

  const filePath = projectFilePath(folder);
  const { commitSha } = await GithubService.getInstance().commitFilesWithContext({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
    message: `Remove project settings: ${folder}`,
    files: [],
    deletions: [filePath],
    workspaceId: params.workspaceId,
    userId: params.userId,
  });

  // `removeMarkdownFile` despite the name: it is the mirror's only public
  // removal, and its extra work (dropping a `sections/` directory that a JSON
  // file never had) is a no-op here. What matters is that it goes through the
  // repo-root containment guard.
  await WorkspaceMirrorService.getInstance().removeMarkdownFile(params.workspaceId, filePath);
  invalidateProjectIndex(params.workspaceId);

  Logger.info('Removed project settings', {
    workspaceId: params.workspaceId,
    folder,
    commitSha,
    userId: params.userId,
  });

  return { commitSha, folder };
}
