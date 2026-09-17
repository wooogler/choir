import { AppConfig } from '@/config';
import type { WebClient } from '@slack/web-api';
import { mapWithConcurrency } from 'services/common/concurrency';
import { ErrorCodes, SlackError } from 'services/common/error-handler';
import { Logger } from 'services/common/logger';
import { getAnonymizationMapping } from 'services/common/name-cache';
import { DEFAULT_LOCALE, type T, createT } from '../../src/i18n';
import { WorkspaceStore } from '../workspace/workspace-store';

const workspaceStore = new WorkspaceStore();

/**
 * 사용자가 관리자인지 확인합니다.
 */
export async function isManager(workspaceId: string, userId: string): Promise<boolean> {
  try {
    const config = await workspaceStore.getWorkspaceConfig(workspaceId);
    return config?.managers.includes(userId) || false;
  } catch (error) {
    Logger.error('Error checking manager status', error as Error, { workspaceId, userId });
    return false;
  }
}

/**
 * 워크스페이스의 모든 관리자 목록을 반환합니다.
 */
export async function getManagers(workspaceId: string): Promise<string[]> {
  try {
    const config = await workspaceStore.getWorkspaceConfig(workspaceId);
    return config?.managers || [];
  } catch (error) {
    Logger.error('Error getting managers list', error as Error, { workspaceId });
    return [];
  }
}

/**
 * 사용자에게 관리자 권한을 부여합니다.
 */
export async function addManager(
  workspaceId: string,
  userId: string,
  grantedBy: string,
  options?: { actorIsOwner?: boolean },
): Promise<boolean> {
  try {
    const result = await workspaceStore.addManager(workspaceId, userId, grantedBy, options);
    Logger.info('Manager added successfully', { workspaceId, userId, grantedBy });
    return result;
  } catch (error) {
    Logger.error('Error adding manager', error as Error, { workspaceId, userId, grantedBy });
    return false;
  }
}

/**
 * 사용자의 관리자 권한을 제거합니다.
 */
export async function removeManager(
  workspaceId: string,
  userId: string,
  removedBy: string,
  options?: { actorIsOwner?: boolean },
): Promise<boolean> {
  try {
    const result = await workspaceStore.removeManager(workspaceId, userId, removedBy, options);
    Logger.info('Manager removed successfully', { workspaceId, userId, removedBy });
    return result;
  } catch (error) {
    Logger.error('Error removing manager', error as Error, { workspaceId, userId, removedBy });
    return false;
  }
}

/**
 * 워크스페이스에 초기 관리자를 설정합니다.
 */
export async function setupInitialManager(
  workspaceId: string,
  initialManagerId: string,
  client: WebClient,
): Promise<void> {
  try {
    await workspaceStore.initializeWorkspace(workspaceId, initialManagerId, client);
    Logger.info('Initial manager setup completed', { workspaceId, initialManagerId });
  } catch (error) {
    Logger.error('Error setting up initial manager', error as Error, { workspaceId, initialManagerId });
    throw new SlackError('Failed to setup initial manager', {
      code: ErrorCodes.SLACK_USER_NOT_FOUND,
      metadata: { workspaceId, initialManagerId },
    });
  }
}

/**
 * 사용자 이름을 가져옵니다.
 */
export async function getUserName(userId: string, client: WebClient): Promise<string> {
  try {
    // Use name cache service which handles bot ID detection
    const { getCachedUserName } = await import('services/common/name-cache');
    return await getCachedUserName(userId, client);
  } catch (error) {
    Logger.error('Error getting user name', error as Error, { userId });
    return 'Unknown';
  }
}

/**
 * 사용자가 워크스페이스의 소유자인지 확인합니다.
 */
export async function isWorkspaceOwner(userId: string, client: WebClient): Promise<boolean> {
  try {
    const userInfo = await client.users.info({ user: userId });
    return userInfo.user?.is_owner === true;
  } catch (error) {
    Logger.error('Error checking workspace owner status', error as Error, { userId });
    return false;
  }
}

// Bot status is effectively immutable per user, so cache it to avoid a users.info
// call per mention (this runs N+1 over every message in the conversation history).
const botUserStatusCache = new Map<string, boolean>();

/**
 * 사용자가 봇인지 확인합니다.
 */
export async function isBotUser(userId: string, client: WebClient): Promise<boolean> {
  const cached = botUserStatusCache.get(userId);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const userInfo = await client.users.info({ user: userId });
    const isBot = !!userInfo.user?.is_bot;
    botUserStatusCache.set(userId, isBot);
    return isBot;
  } catch (error) {
    Logger.error('Error checking bot user status', error as Error, { userId });
    return false;
  }
}

/**
 * 워크스페이스 ID를 가져옵니다.
 */
// team_id keyed by the client's bot token. A single OAuth process serves many
// workspaces, so a global cache would be wrong — but token→team_id is 1:1 and
// stable, so this is safe and removes an auth.test round-trip from every caller
// (getWorkspaceId is on very hot paths, e.g. the usage monitor on each API call).
const workspaceIdByToken = new Map<string, string>();

export async function getWorkspaceId(client: WebClient): Promise<string> {
  const token = (client as unknown as { token?: string }).token;
  if (token) {
    const cached = workspaceIdByToken.get(token);
    if (cached) return cached;
  }

  try {
    const authInfo = await client.auth.test();
    if (!authInfo.team_id) {
      Logger.warn('No team_id in auth.test response', { authInfo });
      throw new Error('No team_id in auth response');
    }

    if (token) workspaceIdByToken.set(token, authInfo.team_id);
    return authInfo.team_id;
  } catch (error) {
    Logger.error('Error getting workspace info', error as Error);
    throw new Error(`Failed to get workspace ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * 워크스페이스의 botUserId를 config에서 읽거나, 없으면 Slack API로 조회 후 저장
 */
export async function getOrInitBotUserId(client: WebClient): Promise<string> {
  const workspaceId = await getWorkspaceId(client);
  const botUserIdFromConfig = await workspaceStore.getBotUserId(workspaceId);
  if (botUserIdFromConfig) return botUserIdFromConfig;
  // 없으면 Slack API로 조회
  const botInfo = await client.auth.test();
  const botUserId = botInfo.user_id;
  if (!botUserId) {
    throw new Error('Failed to get bot user ID from Slack API');
  }
  await workspaceStore.setBotUserId(workspaceId, botUserId);
  return botUserId;
}

/**
 * 캐시된 워크스페이스 ID를 클리어합니다. (테스트용)
 */
export function clearWorkspaceIdCache(): void {
  // Clears the per-token team_id cache (used by tests). Not a global cache — each
  // entry is keyed by a workspace's own bot token.
  workspaceIdByToken.clear();
}

/**
 * 비밀번호를 통해 사용자를 관리자로 승격시킵니다.
 */
export async function promoteToManagerWithPassword(
  workspaceId: string,
  userId: string,
  password: string,
): Promise<boolean> {
  try {
    const config = AppConfig.getManagerPromotionConfig();

    if (!config.password) {
      Logger.warn('Manager promotion password is not configured');
      return false;
    }

    if (password !== config.password) {
      Logger.warn('Invalid password for manager promotion', { workspaceId, userId });
      return false;
    }

    // 워크스페이스가 초기화되지 않은 경우 초기화
    let workspaceConfig = await workspaceStore.getWorkspaceConfig(workspaceId);
    if (!workspaceConfig) {
      Logger.info('Workspace not initialized, creating initial configuration', { workspaceId, userId });

      // 기본 워크스페이스 설정 생성 (setupInitialManager 함수 내용을 간단히 구현)
      workspaceConfig = {
        workspaceId,
        managers: [userId],
        choirUsers: [userId],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await workspaceStore.saveWorkspaceConfig(workspaceConfig);
      Logger.info('Workspace initialized with user as initial manager', { workspaceId, userId });
      return true;
    }

    // 이미 관리자인지 확인
    const isAlreadyManager = await isManager(workspaceId, userId);
    if (isAlreadyManager) {
      Logger.info('User is already a manager', { workspaceId, userId });
      return true;
    }

    // 관리자로 승격
    const result = await workspaceStore.addManager(workspaceId, userId, 'self-promotion');

    if (result) {
      Logger.info('User promoted to manager via password', { workspaceId, userId });
    } else {
      Logger.error('Failed to promote user to manager', undefined, { workspaceId, userId });
    }

    return result;
  } catch (error) {
    Logger.error('Error promoting user to manager with password', error as Error);
    return false;
  }
}

/**
 * CHOIR 사용자 목록을 가져옵니다.
 */
export async function getCHOIRUsers(workspaceId: string): Promise<string[]> {
  try {
    return await workspaceStore.getCHOIRUsers(workspaceId);
  } catch (error) {
    Logger.error('Error getting CHOIR users', error as Error, { workspaceId });
    return [];
  }
}

// Workspaces whose CHOIR users have been re-registered into the workspace-scoped
// anonymization map (a one-time lazy migration from the legacy global map).
// In-memory only — a restart re-runs it, which is idempotent (get-or-create).
const anonymizationMigratedWorkspaces = new Set<string>();

/**
 * Lazily re-registers every CHOIR user of a workspace into the workspace-scoped
 * anonymization map. Needed after moving mappings from a single global map to
 * per-workspace scoping: without it, a user's name (including someone merely
 * mentioned in a message, not just the sender) would stop being masked until the
 * manager re-saved the CHOIR user list. Runs at most once per workspace per
 * process; best-effort and cheap to call on every message.
 */
export async function ensureWorkspaceAnonymizationMigrated(workspaceId: string, client: WebClient): Promise<void> {
  if (anonymizationMigratedWorkspaces.has(workspaceId)) return;
  try {
    const userIds = await getCHOIRUsers(workspaceId);
    // Resolve names with bounded concurrency instead of one-at-a-time: on a cold
    // name cache this ran O(users) sequential users.info calls and stalled the
    // first message of a large workspace. The cap keeps the fan-out from bursting
    // into Slack rate limits.
    await mapWithConcurrency(userIds, 8, async (userId) => {
      try {
        const userName = await getUserName(userId, client);
        getAnonymizationMapping(userId, userName, undefined, workspaceId);
      } catch (error) {
        Logger.warn('Failed to migrate user into scoped anonymization map', { workspaceId, userId, error });
      }
    });
    anonymizationMigratedWorkspaces.add(workspaceId);
  } catch (error) {
    // Leave the workspace unflagged so a later message retries the migration.
    Logger.warn('Failed to migrate workspace anonymization mappings', { workspaceId, error });
  }
}

/**
 * CHOIR 사용자 목록을 설정합니다.
 */
export async function setCHOIRUsers(workspaceId: string, userIds: string[], client?: WebClient): Promise<boolean> {
  try {
    const result = await workspaceStore.setCHOIRUsers(workspaceId, userIds);

    // Register users in name-mapping for anonymization
    if (client) {
      for (const userId of userIds) {
        try {
          const userName = await getUserName(userId, client);
          getAnonymizationMapping(userId, userName, undefined, workspaceId);
          Logger.info('User registered in anonymization mapping', { userId, userName });
        } catch (error) {
          Logger.warn('Failed to register user in anonymization mapping', { userId, error });
        }
      }
    }

    Logger.info('CHOIR users updated', { workspaceId, userCount: userIds.length });
    return result;
  } catch (error) {
    Logger.error('Error setting CHOIR users', error as Error, { workspaceId, userIds });
    return false;
  }
}

/**
 * 사용자가 CHOIR 사용자인지 확인합니다.
 */
export async function isCHOIRUser(workspaceId: string, userId: string): Promise<boolean> {
  try {
    const choirUsers = await workspaceStore.getCHOIRUsers(workspaceId);
    return choirUsers.includes(userId);
  } catch (error) {
    Logger.error('Error checking CHOIR user status', error as Error, { workspaceId, userId });
    return false;
  }
}

/**
 * Resolve a set of Slack user IDs to display names in one pass (deduped). Used to
 * store readable speaker names on provenance records at write time so the viewer
 * shows names, not IDs. Failed lookups are simply omitted.
 */
export async function resolveUserNames(
  userIds: Array<string | undefined>,
  client: WebClient,
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.filter((id): id is string => !!id))];
  const out = new Map<string, string>();
  await Promise.all(
    unique.map(async (id) => {
      try {
        out.set(id, await getUserName(id, client));
      } catch {
        // omit — caller falls back to the id
      }
    }),
  );
  return out;
}

/**
 * Get formatted manager text with all manager names
 */
export async function getManagerText(workspaceId: string, client: WebClient): Promise<string> {
  try {
    const managers = await getManagers(workspaceId);
    if (managers.length === 0) {
      return 'managers';
    }

    // Get all manager names
    const managerNames = await Promise.all(managers.map((managerId) => getUserName(managerId, client)));

    return managerNames.join(', ');
  } catch (error) {
    Logger.error('Error getting manager text', error as Error, { workspaceId });
    return 'managers';
  }
}

/**
 * Registers an approved user as a CHOIR user in one step: adds them to the
 * workspace's CHOIR user list and enrolls them in the workspace-scoped
 * anonymization map. The anonymization step mirrors setCHOIRUsers() and is
 * essential — without it the user's real name would reach the LLM unmasked until
 * a manager next re-saved the CHOIR user list.
 */
export async function approveCHOIRUser(workspaceId: string, userId: string, client: WebClient): Promise<void> {
  await workspaceStore.addCHOIRUser(workspaceId, userId);

  try {
    const userName = await getUserName(userId, client);
    getAnonymizationMapping(userId, userName, undefined, workspaceId);
    Logger.info('Approved user registered in anonymization mapping', { workspaceId, userId });
  } catch (error) {
    Logger.warn('Failed to register approved user in anonymization mapping', { workspaceId, userId, error });
  }
}

export type NonUserResponseState = 'fresh' | 'pending' | 'declined';

/**
 * Builds the reply shown to a non-CHOIR-user, varying by where they are in the
 * self-service access flow. The caller supplies an AUTHORIZATION block_id (so the
 * message is excluded from conversation history) and, for the 'fresh' state,
 * appends the "Request Access" button itself (keeping the button's action_id in
 * the listener layer). Returns `{ text, blocks }` ready to post.
 *
 * `t` is the translator of the person being told — a stranger who has never
 * interacted with CHOIR, so their locale is worth one `users.info` at the call
 * site. It is optional, defaulting to English, so a caller with no locale in
 * hand (and the builder's own tests) still get the previous output exactly.
 */
export async function buildNonUserResponse(
  state: NonUserResponseState,
  options: {
    authorizationBlockId: string;
    consentFormUrl?: string;
    t?: T;
  },
): Promise<{ text: string; blocks: any[] }> {
  const { authorizationBlockId, consentFormUrl } = options;
  const t = options.t ?? createT(DEFAULT_LOCALE);

  if (state === 'pending') {
    const text = t('registration.nonUser.pending');
    return { text, blocks: [section(text, authorizationBlockId)] };
  }

  if (state === 'declined') {
    const text = t('registration.nonUser.declined');
    return { text, blocks: [section(text, authorizationBlockId)] };
  }

  // fresh
  const text = t('registration.nonUser.fresh');
  const blocks: any[] = [
    section(text, authorizationBlockId),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: t('registration.nonUser.fresh.privacy'),
        },
      ],
    },
  ];

  if (consentFormUrl) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: t('registration.nonUser.fresh.consent', {
            consentFormLink: `<${consentFormUrl}|${t('registration.link.consentFormHere')}>`,
          }),
        },
      ],
    });
  }

  return { text, blocks };
}

function section(text: string, blockId?: string) {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text },
    ...(blockId ? { block_id: blockId } : {}),
  };
}
