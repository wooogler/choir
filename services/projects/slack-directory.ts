import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { getProject } from './project-index';
import { ProjectRefusal } from './refusal';
import type { MemberSource } from './schema';

/**
 * Reading channels and people from Slack, for the project settings GUI.
 *
 * Nothing here is written to the repository (docs/project-folders.md 1): the
 * membership of a channel is Slack's to know, and a copy in git would be stale
 * the moment somebody joined. So this is a read-through cache with a short life
 * — long enough that opening the Members tab does not re-fetch every user, short
 * enough that a manager who just invited someone sees them after a coffee.
 */

/** How long channel membership and user profiles are reused (docs/project-folders.md 5). */
export const SLACK_DIRECTORY_TTL_MS = 10 * 60 * 1000;

/** Slack's per-page maximum for the two paginated calls below. */
const PAGE_SIZE = 200;

/** Refuses to loop forever if Slack keeps handing back a cursor. */
const MAX_PAGES = 50;

export interface SlackChannelSummary {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  memberCount?: number;
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
  /** Dictation spellings from the project's `members.aliases`. */
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

interface CacheEntry<T> {
  fetchedAt: number;
  value: T;
}

const channelMemberCache = new Map<string, CacheEntry<ChannelMembersResult>>();
const userCache = new Map<string, CacheEntry<SlackMember | null>>();
const privateReadableCache = new Map<string, CacheEntry<boolean>>();

/** Test seam, and what an uninstall would call. */
export function clearSlackDirectoryCache(): void {
  channelMemberCache.clear();
  userCache.clear();
  privateReadableCache.clear();
}

function fresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < SLACK_DIRECTORY_TTL_MS;
}

/**
 * The cache is per workspace because a bot token is. A caller that knows the
 * workspace id says so; everyone else is keyed by the client's own token, which
 * identifies the same thing (name-cache reads it the same way).
 */
function workspaceKey(client: WebClient, workspaceId?: string): string {
  if (workspaceId) return workspaceId;
  return (client as unknown as { token?: string }).token ?? 'unknown-workspace';
}

/** Slack's `data.error` string, when the failure came from the API rather than the wire. */
function slackErrorCode(error: unknown): string | undefined {
  const data = (error as { data?: { error?: unknown } } | undefined)?.data;
  return typeof data?.error === 'string' ? data.error : undefined;
}

/** Channel errors the caller answers with an empty list rather than a refusal. */
const SOFT_CHANNEL_ERRORS = new Set(['channel_not_found', 'not_in_channel', 'is_archived']);

/**
 * Turns a Slack failure into the API's vocabulary.
 *
 * `missing_scope` is the one a manager can actually fix — the private-channel
 * scope was added in PF1 and existing installs have not re-authorized — so it
 * carries the scope name and a 403. Everything else is Slack being unreachable,
 * which is a 503 the GUI retries.
 */
function toRefusal(error: unknown, context: string): ProjectRefusal {
  const code = slackErrorCode(error);
  if (code === 'missing_scope') {
    const needed = (error as { data?: { needed?: unknown } }).data?.needed;
    return new ProjectRefusal(403, 'slack_scope_missing', {
      scope: typeof needed === 'string' ? needed : 'groups:read',
    });
  }
  Logger.warn('Slack directory call failed', { context, code, error: String(error) });
  return new ProjectRefusal(503, 'slack_unavailable', { message: code ?? (error as Error)?.message ?? context });
}

/**
 * Every channel the bot can see: public ones, plus the private ones it belongs
 * to when the workspace has granted `groups:read`.
 *
 * Archived channels are included rather than filtered out — a project linked to
 * one should say so in the GUI, and silently dropping it would make the link
 * look like it had been lost.
 */
export async function listChannels(client: WebClient): Promise<SlackChannelSummary[]> {
  const channels: SlackChannelSummary[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: Awaited<ReturnType<WebClient['conversations']['list']>>;
    try {
      response = await client.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: false,
        limit: PAGE_SIZE,
        cursor,
      });
    } catch (error) {
      throw toRefusal(error, 'conversations.list');
    }

    for (const channel of response.channels ?? []) {
      if (!channel.id) continue;
      channels.push({
        id: channel.id,
        name: channel.name ?? channel.id,
        isPrivate: Boolean(channel.is_private),
        isArchived: Boolean(channel.is_archived),
        memberCount: typeof channel.num_members === 'number' ? channel.num_members : undefined,
      });
    }

    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  return channels;
}

/**
 * Whether this workspace has granted the private-channel scope.
 *
 * Probed rather than read off the installation record: the scopes a token
 * actually carries are what Slack will honour, and a workspace installed before
 * `groups:read` was added keeps its old grant until someone re-authorizes.
 */
export async function privateChannelsReadable(client: WebClient, workspaceId?: string): Promise<boolean> {
  const key = workspaceKey(client, workspaceId);
  const cached = privateReadableCache.get(key);
  if (fresh(cached)) return cached.value;

  let readable = false;
  try {
    await client.conversations.list({ types: 'private_channel', exclude_archived: false, limit: 1 });
    readable = true;
  } catch (error) {
    if (slackErrorCode(error) !== 'missing_scope') {
      Logger.warn('Private-channel probe failed for a reason other than the scope', {
        workspaceId: key,
        error: String(error),
      });
    }
    readable = false;
  }

  privateReadableCache.set(key, { fetchedAt: Date.now(), value: readable });
  return readable;
}

/**
 * The members of one channel, bots included and flagged.
 *
 * Bots are returned rather than dropped so the Members tab can show why a
 * channel of 12 has 9 people in the project; `projectMembers` is where they are
 * excluded. Deleted accounts are dropped outright — they are nobody.
 */
export async function channelMembers(
  client: WebClient,
  channelId: string,
  workspaceId?: string,
): Promise<ChannelMembersResult> {
  const key = `${workspaceKey(client, workspaceId)}:${channelId}`;
  const cached = channelMemberCache.get(key);
  if (fresh(cached)) return cached.value;

  const ids: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: Awaited<ReturnType<WebClient['conversations']['members']>>;
    try {
      response = await client.conversations.members({ channel: channelId, limit: PAGE_SIZE, cursor });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code && SOFT_CHANNEL_ERRORS.has(code)) {
        // A channel the bot was removed from is a state the GUI explains, not
        // an error that should fail the whole Members tab.
        const result: ChannelMembersResult = { members: [], warning: `${channelId}: ${code}` };
        channelMemberCache.set(key, { fetchedAt: Date.now(), value: result });
        return result;
      }
      throw toRefusal(error, 'conversations.members');
    }

    ids.push(...(response.members ?? []));
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  const members = await lookupUsers(client, ids, workspaceId);
  const result: ChannelMembersResult = { members };
  channelMemberCache.set(key, { fetchedAt: Date.now(), value: result });
  return result;
}

/**
 * The people a project's meeting notes and prompts should know about.
 *
 * `curated` short-circuits the channel walk entirely: a 400-person channel is
 * exactly the case the curated list exists for, and fetching all 400 profiles to
 * then throw them away would be the slowest possible way to honour it.
 */
export async function projectMembers(
  workspaceId: string,
  folder: string,
  client: WebClient,
): Promise<ProjectMembersResult> {
  const project = await getProject(workspaceId, folder);
  if (!project) {
    throw new ProjectRefusal(404, 'project_not_found', { folder });
  }

  const { members: settings } = project.settings;
  const withAliases = (member: SlackMember): ProjectMember => ({
    ...member,
    aliases: settings.aliases[member.id] ?? [],
  });

  if (settings.source === 'curated') {
    const looked = await lookupUsers(client, settings.curated, workspaceId);
    return { members: looked.map(withAliases), source: 'curated' };
  }

  const byId = new Map<string, SlackMember>();
  const warnings: string[] = [];
  for (const channel of project.settings.channels) {
    const result = await channelMembers(client, channel, workspaceId);
    if (result.warning) warnings.push(result.warning);
    for (const member of result.members) {
      if (member.isBot) continue;
      if (!byId.has(member.id)) byId.set(member.id, member);
    }
  }

  return {
    members: [...byId.values()].map(withAliases),
    source: 'channels',
    ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
  };
}

/**
 * `users.info` for a list of ids, cached per user.
 *
 * Sequential rather than parallel: `users.info` is a Tier 4 method and a
 * 200-person channel opened by three managers at once would otherwise spend the
 * workspace's rate limit on a dialog. The cache makes the second open free.
 */
async function lookupUsers(client: WebClient, ids: string[], workspaceId?: string): Promise<SlackMember[]> {
  const workspace = workspaceKey(client, workspaceId);
  const members: SlackMember[] = [];

  for (const id of ids) {
    const key = `${workspace}:${id}`;
    const cached = userCache.get(key);
    if (fresh(cached)) {
      if (cached.value) members.push(cached.value);
      continue;
    }

    let member: SlackMember | null = null;
    try {
      const response = await client.users.info({ user: id });
      const user = response.user;
      // A deleted account is nobody: it cannot attend a meeting or answer a
      // question, and showing it would only invite someone to tick its box.
      if (user && !user.deleted) {
        member = {
          id,
          name: user.real_name || user.profile?.display_name || user.name || id,
          title: user.profile?.title || undefined,
          avatar: user.profile?.image_72 || undefined,
          isBot: Boolean(user.is_bot),
        };
      }
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === 'missing_scope') throw toRefusal(error, 'users.info');
      // One unreadable profile should not empty the roster.
      Logger.warn('Could not read a Slack profile', { user: id, code });
      member = { id, name: id, isBot: false };
    }

    userCache.set(key, { fetchedAt: Date.now(), value: member });
    if (member) members.push(member);
  }

  return members;
}
