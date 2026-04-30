import { Logger } from 'services/common/logger';
import { getRetrievalProvider } from 'services/retrieval';

export function getQmdWarmupQuery(): string {
  return process.env.QMD_WARMUP_QUERY?.trim() || 'documentation';
}

export function scheduleQmdWarmup(params: {
  workspaceId: string;
  reason: string;
  delayMs?: number;
  enabled?: boolean;
}): void {
  if (params.enabled === false) {
    return;
  }

  const query = getQmdWarmupQuery();

  setTimeout(() => {
    void (async () => {
      try {
        Logger.info('Starting background QMD warm-up.', {
          workspaceId: params.workspaceId,
          query,
          reason: params.reason,
        });

        const retrievalProvider = getRetrievalProvider();
        await retrievalProvider.warmup?.({
          workspaceId: params.workspaceId,
          query,
        });

        Logger.info('Background QMD warm-up finished.', {
          workspaceId: params.workspaceId,
          reason: params.reason,
        });
      } catch (error) {
        Logger.warn('Background QMD warm-up failed.', {
          workspaceId: params.workspaceId,
          query,
          reason: params.reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, params.delayMs ?? 0);
}
