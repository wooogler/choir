import type { WebClient } from '@slack/web-api';
import { ErrorCodes, SlackError } from 'services/common/error-handler';
import { Logger } from 'services/common/logger';
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
    const userInfo = await client.users.info({ user: userId });

    if (userInfo.user?.is_bot) {
      return userInfo.user?.real_name || userInfo.user?.name || 'Bot';
    }

    return userInfo.user?.real_name ?? userInfo.user?.name ?? 'Unknown';
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
 * 워크스페이스 ID를 가져옵니다.
 */
export async function getWorkspaceId(client: WebClient): Promise<string> {
  try {
    const authInfo = await client.auth.test();
    if (!authInfo.team_id) {
      Logger.warn('No team_id in auth.test response', { authInfo });
      throw new Error('No team_id in auth response');
    }
    return authInfo.team_id;
  } catch (error) {
    Logger.error('Error getting workspace info', error as Error);
    throw new Error(`Failed to get workspace ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
