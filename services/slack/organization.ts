import { Logger } from 'services/common/logger';
import { WorkspaceStore } from '../workspace/workspace-store';

const workspaceStore = new WorkspaceStore();

/**
 * Organization name을 설정합니다.
 */
export async function setOrganizationName(workspaceId: string, name: string): Promise<void> {
  try {
    await workspaceStore.setOrganizationName(workspaceId, name);
    Logger.info('Organization name set successfully', { workspaceId, name });
  } catch (error) {
    Logger.error('Error setting organization name', error as Error, { workspaceId, name });
    throw error;
  }
}

/**
 * Organization name을 가져옵니다.
 */
export async function getOrganizationName(workspaceId: string): Promise<string | null> {
  try {
    const config = await workspaceStore.getWorkspaceConfig(workspaceId);
    return config?.organizationName || null;
  } catch (error) {
    Logger.error('Error getting organization name', error as Error, { workspaceId });
    return null;
  }
}

/**
 * Organization description을 설정합니다.
 */
export async function setOrganizationDescription(workspaceId: string, description: string): Promise<void> {
  try {
    await workspaceStore.setOrganizationDescription(workspaceId, description);
    Logger.info('Organization description set successfully', { workspaceId, description });
  } catch (error) {
    Logger.error('Error setting organization description', error as Error, { workspaceId, description });
    throw error;
  }
}

/**
 * Organization description을 가져옵니다.
 */
export async function getOrganizationDescription(workspaceId: string): Promise<string | null> {
  try {
    const config = await workspaceStore.getWorkspaceConfig(workspaceId);
    return config?.organizationDescription || null;
  } catch (error) {
    Logger.error('Error getting organization description', error as Error, { workspaceId });
    return null;
  }
}
