/**
 * Project folders: a repository folder declared as a project, the Slack
 * channels that belong to it, and the people those channels hold.
 *
 * See docs/project-folders.md. The schema and the index are pure enough to be
 * imported anywhere; the store and the Slack directory reach GitHub and Slack,
 * and `./routes` is registered from app.ts.
 */

export {
  DEFAULT_GLOSSARY,
  DEFAULT_MEETINGS_FOLDER,
  PROJECT_FILE,
  PROJECT_VERSION,
  type MemberSource,
  type ParseResult,
  type ProjectMembersSettings,
  type ProjectScopeSettings,
  type ProjectSettings,
  type RetrievalScope,
  type UpdateScope,
  normalizeProjectFolder,
  parseProjectSettings,
  serializeProjectSettings,
} from './schema';

export {
  PROJECT_INDEX_TTL_MS,
  type BrokenProjectFile,
  type ProjectIndex,
  type ProjectRecord,
  brokenProjectFiles,
  clearProjectIndexCache,
  getProject,
  getProjectIndex,
  invalidateProjectIndex,
  listProjects,
  resolveProjectForChannel,
  resolveProjectForPath,
} from './project-index';

export { ProjectRefusal } from './refusal';

export { type SaveProjectResult, deleteProject, projectFilePath, saveProject } from './project-store';

export {
  SLACK_DIRECTORY_TTL_MS,
  type ChannelMembersResult,
  type ProjectMember,
  type ProjectMembersResult,
  type SlackChannelSummary,
  type SlackMember,
  channelMembers,
  clearSlackDirectoryCache,
  listChannels,
  privateChannelsReadable,
  projectMembers,
} from './slack-directory';

export { type ProjectRouteDeps, type ProjectSummary, registerProjectRoutes } from './routes';
