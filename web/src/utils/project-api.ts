/**
 * The viewer's client for the project-folder endpoints
 * (`/api/docs/:ws/projects/…` and `/api/docs/:ws/slack/…`).
 *
 * One module rather than a fetch in every tab of the settings dialog, because
 * the six calls share the same three chores: percent-encoding a folder path
 * into a splat route, turning a refusal into an `ApiError` carrying the
 * server's *code*, and reading the one shape the route answers with.
 *
 * The settings types are imported — as types — from the server module that
 * defines them, the way `i18n/server-errors.ts` imports its error codes:
 * `services/projects/schema.ts` has no imports of its own, so nothing of the
 * node app comes along, and a field renamed there stops this file compiling
 * instead of silently writing a key the validator will reject.
 *
 * See docs/project-folders.md sections 1 and 6.
 */

import type {
  MemberSource,
  ProjectMembersSettings,
  ProjectScopeSettings,
  ProjectSettings,
  RetrievalScope,
  UpdateScope,
} from '../../../services/projects/schema';
import type { T } from '../i18n';
import { ApiError, describeApiError, errorPayload } from './api-error';
import { encodePath } from './docs';

export type {
  MemberSource,
  ProjectMembersSettings,
  ProjectScopeSettings,
  ProjectSettings,
  RetrievalScope,
  UpdateScope,
};
export { ApiError as ProjectApiError };

/** A project on the wire: its folder, flattened over its settings. */
export interface ProjectSummary extends ProjectSettings {
  folder: string;
  /** Display names for `channels`, when Slack could be reached. */
  channelNames?: Record<string, string>;
}

/** What `PUT` accepts: everything but `version`, which the server stamps. */
export type ProjectSettingsInput = Omit<ProjectSettings, 'version'>;

/** A `.choir/project.json` the index had to skip, with the English reason. */
export interface BrokenProjectFile {
  folder: string;
  error: string;
}

export interface ProjectListResult {
  projects: ProjectSummary[];
  broken: BrokenProjectFile[];
}

export interface SlackChannelSummary {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  memberCount?: number;
  /** Set when this channel already belongs to a project — a different one, by definition. */
  linkedFolder?: string;
}

export interface ChannelListResult {
  channels: SlackChannelSummary[];
  /** False when the install never granted `groups:read`, so private channels are missing. */
  privateChannelsReadable: boolean;
}

export interface SlackMember {
  id: string;
  name: string;
  /** The Slack profile title ("Research Lead"), when the workspace fills it in. */
  title?: string;
  avatar?: string;
  isBot: boolean;
}

export interface ProjectMember extends SlackMember {
  aliases: string[];
}

export interface ChannelMembersResult {
  members: SlackMember[];
  /** Set when the channel could not be read at all — the bot is not in it, or it is gone. */
  warning?: string;
}

export interface ProjectMembersResult {
  members: ProjectMember[];
  source: MemberSource;
  warning?: string;
}

export interface ProjectSaveResult {
  project: ProjectSummary;
  commitSha: string;
}

/** The sentence to show for a failed project call, in the reader's language. */
export function describeProjectError(t: T, error: unknown, fallback: string): string {
  return describeApiError(t, error, fallback);
}

/** The default `meetingsFolder`, repeated from `services/projects/schema.ts`. */
const DEFAULT_MEETINGS_FOLDER = 'meetings';

/**
 * The project a document (or a folder) belongs to: the longest declared folder
 * that contains it, so `projects/alpha/meetings` is read as alpha's rather
 * than as the repository-wide project somebody declared at the root.
 *
 * Generic in the project so a caller holding a narrower row — a folder and
 * nothing else — can use it too.
 */
export function nearestProject<TProject extends { folder: string }>(
  projects: TProject[],
  path: string,
): TProject | null {
  let best: TProject | null = null;
  for (const project of projects) {
    const folder = project.folder;
    const contains = folder === '' || path === folder || path.startsWith(`${folder}/`);
    if (contains && (best === null || folder.length > best.folder.length)) best = project;
  }
  return best;
}

/**
 * Where this project keeps its meeting notes, as a repository path.
 * `meetingsFolder` is relative to the project folder (docs/project-folders.md).
 */
export function meetingsFolderOf(project: { folder: string; meetingsFolder?: string }): string {
  const relative = (project.meetingsFolder ?? DEFAULT_MEETINGS_FOLDER).trim().replace(/^\/+|\/+$/g, '');
  const parts = [project.folder, relative || DEFAULT_MEETINGS_FOLDER].filter(Boolean);
  return parts.join('/');
}

function docsBase(workspaceId: string): string {
  return `/api/docs/${encodeURIComponent(workspaceId)}`;
}

/**
 * A folder inside a splat route. Each segment is encoded on its own so the
 * slashes stay slashes — Express hands `*folder` over as the path parts, and
 * encoding the whole string would arrive as one segment named `a%2Fb`.
 */
function folderUrl(workspaceId: string, folder: string, suffix = ''): string {
  return `${docsBase(workspaceId)}/projects/${encodePath(folder)}${suffix}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (!response.ok) throw new ApiError(await errorPayload(response), response.status);
  return (await response.json()) as T;
}

/** Every project in the workspace, plus the metadata files that would not parse. */
export async function listProjects(workspaceId: string): Promise<ProjectListResult> {
  const result = await request<Partial<ProjectListResult>>(`${docsBase(workspaceId)}/projects`);
  return { projects: result.projects ?? [], broken: result.broken ?? [] };
}

/**
 * One project, or `null` when that folder is not one.
 *
 * "Not a project" is the answer for every folder the dialog is opened on
 * before anybody has declared it, so it is returned rather than thrown; every
 * other refusal still throws.
 */
export async function getProject(workspaceId: string, folder: string): Promise<ProjectSummary | null> {
  try {
    const result = await request<{ project: ProjectSummary }>(folderUrl(workspaceId, folder));
    return result.project;
  } catch (error) {
    if (error instanceof ApiError && error.payload.error === 'project_not_found') return null;
    throw error;
  }
}

/** Writes `.choir/project.json` — a commit, so this is where the refusals live. */
export function saveProject(
  workspaceId: string,
  folder: string,
  settings: ProjectSettingsInput,
): Promise<ProjectSaveResult> {
  return request<ProjectSaveResult>(folderUrl(workspaceId, folder), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

/** Removes the metadata file. The folder and its documents stay where they are. */
export async function deleteProject(workspaceId: string, folder: string): Promise<void> {
  const response = await fetch(folderUrl(workspaceId, folder), { method: 'DELETE', credentials: 'same-origin' });
  // 204, so there is no body to read on the way out.
  if (!response.ok) throw new ApiError(await errorPayload(response), response.status);
}

/** The project's members as the server resolves them, with their stored aliases. */
export function projectMembers(workspaceId: string, folder: string): Promise<ProjectMembersResult> {
  return request<ProjectMembersResult>(folderUrl(workspaceId, folder, '/members'));
}

/** Every channel the bot can see, each flagged with the project that owns it. */
export async function listChannels(workspaceId: string): Promise<ChannelListResult> {
  const result = await request<Partial<ChannelListResult>>(`${docsBase(workspaceId)}/slack/channels`);
  return { channels: result.channels ?? [], privateChannelsReadable: result.privateChannelsReadable !== false };
}

/** One channel's members, live from Slack (behind the server's ten-minute cache). */
export async function channelMembers(workspaceId: string, channelId: string): Promise<ChannelMembersResult> {
  const result = await request<Partial<ChannelMembersResult>>(
    `${docsBase(workspaceId)}/slack/channels/${encodeURIComponent(channelId)}/members`,
  );
  return { members: result.members ?? [], warning: result.warning };
}
