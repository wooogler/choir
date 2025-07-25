import { AppConfig } from '@/config';
import type { WebClient } from '@slack/web-api';
import { ErrorCodes, SlackError } from 'services/common/error-handler';
import { Logger } from 'services/common/logger';
import { getAnonymizationMapping } from 'services/common/name-cache';
import { WorkspaceStore } from '../workspace/workspace-store';

const workspaceStore = new WorkspaceStore();

// Workspace ID 캐시
let cachedWorkspaceId: string | null = null;

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
export async function addManager(workspaceId: string, userId: string, grantedBy: string): Promise<boolean> {
  try {
    const result = await workspaceStore.addManager(workspaceId, userId, grantedBy);
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
export async function removeManager(workspaceId: string, userId: string, removedBy: string): Promise<boolean> {
  try {
    const result = await workspaceStore.removeManager(workspaceId, userId, removedBy);
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

/**
 * 사용자가 봇인지 확인합니다.
 */
export async function isBotUser(userId: string, client: WebClient): Promise<boolean> {
  try {
    const userInfo = await client.users.info({ user: userId });
    return !!userInfo.user?.is_bot;
  } catch (error) {
    Logger.error('Error checking bot user status', error as Error, { userId });
    return false;
  }
}

/**
 * 워크스페이스 ID를 가져옵니다. (캐시됨)
 */
export async function getWorkspaceId(client: WebClient): Promise<string> {
  // 캐시된 값이 있으면 반환
  if (cachedWorkspaceId) {
    return cachedWorkspaceId;
  }

  try {
    const authInfo = await client.auth.test();
    if (!authInfo.team_id) {
      Logger.warn('No team_id in auth.test response', { authInfo });
      throw new Error('No team_id in auth response');
    }
    
    // 캐시에 저장
    cachedWorkspaceId = authInfo.team_id;
    Logger.info('Workspace ID cached', { workspaceId: cachedWorkspaceId });
    
    return cachedWorkspaceId;
  } catch (error) {
    Logger.error('Error getting workspace info', error as Error);
    throw new Error(`Failed to get workspace ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * 캐시된 워크스페이스 ID를 클리어합니다. (테스트용)
 */
export function clearWorkspaceIdCache(): void {
  cachedWorkspaceId = null;
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
          getAnonymizationMapping(userId, userName);
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
 * Get formatted manager text with all manager names
 */
export async function getManagerText(workspaceId: string, client: WebClient): Promise<string> {
  try {
    const managers = await getManagers(workspaceId);
    if (managers.length === 0) {
      return 'managers';
    }

    // Get all manager names
    const managerNames = await Promise.all(
      managers.map(managerId => getUserName(managerId, client))
    );

    return managerNames.join(', ');
  } catch (error) {
    Logger.error('Error getting manager text', error as Error, { workspaceId });
    return 'managers';
  }
}

/**
 * Get standardized Non-user response message with manager list and consent form URL
 */
export async function getNonUserResponseMessage(
  managers: string[],
  consentFormUrl?: string,
  client?: WebClient,
): Promise<string> {
  let managerMentions: string;

  if (client) {
    // Get actual usernames
    const managerNames = await Promise.all(
      managers.map(async (id) => {
        const name = await getUserName(id, client);
        return `*${name}*`;
      }),
    );
    managerMentions = managerNames.join(', ');
  } else {
    // Fallback to user IDs if no client provided
    managerMentions = managers.map((id) => `*${id}*`).join(', ');
  }

  const consentSection = consentFormUrl
    ? `2. *Complete the research consent form* - <${consentFormUrl}|Click here to access the consent form>`
    : '2. *Complete the research consent form* - your manager will provide you with the consent form link';

  return `Hi there! 👋 

I'd love to help you, but it looks like you're not currently registered as a CHOIR user. CHOIR is part of a research study designed to help teams manage and access their collective knowledge more effectively.

To start using CHOIR, you'll need to:
1. *Contact a CHOIR developer* - Sangwook Lee (sangwooklee@vt.edu) can add you to the CHOIR user list
${consentSection}

*Why join?* CHOIR can help you quickly find answers from your team's documentation, get contextual responses to questions, and contribute to advancing research on AI-powered collaboration tools.

If you're interested in participating, please reach out to one of your workspace managers who can guide you through the process. We'd be happy to have you as part of our research community! 🎓✨

_Note: Your messages and interactions are not being recorded or used for research purposes until you officially join as a CHOIR user._`;
}
