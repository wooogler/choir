import { Logger } from 'services/common/logger';
import { purgeWorkspaceSessions } from 'services/common/session-store';
import { purgeWorkspaceAppState } from 'services/document/document-store';
import { QmdUpdateAnchorService } from 'services/document/qmd-update-anchor-service';
import { getRetrievalProvider } from 'services/retrieval';
import { SqliteSlackInstallationStore } from 'services/slack/sqlite-installation-store';
import { VectorStoreService } from 'services/vector/main-service';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';

export interface WorkspaceCleanupResult {
  workspaceId: string;
  removedSessions: number;
  removedAppState: number;
  removedInstallation: boolean;
  removedWorkspaceConfig: boolean;
  purgedCache: boolean;
}

export class WorkspaceCleanupService {
  private static instance: WorkspaceCleanupService;

  public static getInstance(): WorkspaceCleanupService {
    if (!WorkspaceCleanupService.instance) {
      WorkspaceCleanupService.instance = new WorkspaceCleanupService();
    }

    return WorkspaceCleanupService.instance;
  }

  public async purgeWorkspaceCache(workspaceId: string): Promise<void> {
    await WorkspaceMirrorService.getInstance().purgeWorkspaceCache(workspaceId);
    VectorStoreService.getInstance().clearWorkspaceState(workspaceId);
    await this.invalidateQmdCaches(workspaceId);

    Logger.info('WorkspaceCleanupService: purged workspace cache.', { workspaceId });
  }

  public async cleanupUninstalledWorkspace(workspaceId: string): Promise<WorkspaceCleanupResult> {
    const result: WorkspaceCleanupResult = {
      workspaceId,
      removedSessions: 0,
      removedAppState: 0,
      removedInstallation: false,
      removedWorkspaceConfig: false,
      purgedCache: false,
    };

    result.removedSessions = purgeWorkspaceSessions(workspaceId);
    result.removedAppState = purgeWorkspaceAppState(workspaceId);

    await this.purgeWorkspaceCache(workspaceId);
    result.purgedCache = true;

    await new WorkspaceStore().removeWorkspace(workspaceId);
    result.removedWorkspaceConfig = true;

    await new SqliteSlackInstallationStore().deleteWorkspaceInstallation(workspaceId);
    result.removedInstallation = true;

    Logger.info('WorkspaceCleanupService: completed uninstall cleanup.', {
      workspaceId,
      removedSessions: result.removedSessions,
      removedAppState: result.removedAppState,
    });

    return result;
  }

  private async invalidateQmdCaches(workspaceId: string): Promise<void> {
    await QmdUpdateAnchorService.getInstance().invalidateWorkspace(workspaceId);

    const retrievalProvider = getRetrievalProvider() as {
      invalidateWorkspace?: (workspaceId: string) => Promise<void>;
    };
    await retrievalProvider.invalidateWorkspace?.(workspaceId);
  }
}
