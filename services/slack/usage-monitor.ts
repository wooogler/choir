import { WebClient } from '@slack/web-api';
import { AsyncLocalStorage } from 'async_hooks';
import { Logger } from 'services/common/logger';
import { getUserName, getWorkspaceId } from 'services/slack/user-management';

type ActorContext = {
  userId?: string;
};

/**
 * Slack API 사용량 모니터링: 1분 내 지정 메서드(chat.postMessage, chat.update, chat.delete) 호출이
 * N회 이상이면 키워드 사용자에게 알림 전송. 기본 N=30.
 *
 * 구현 방식
 * - WebClient.prototype.apiCall을 1회 전역 패치하여 모든 인스턴스의 호출을 가로챔
 * - AsyncLocalStorage로 현재 요청의 유저 ID(행위자)를 전파
 * - (workspaceId, actorId, windowStartMs) 단위로 카운팅하며 초과 시 1회만 알림
 */
export class SlackUsageMonitor {
  private static instance: SlackUsageMonitor | null = null;

  private readonly usageCounters: Map<string, number> = new Map();
  private readonly notifiedWindows: Set<string> = new Set();
  private readonly windowMs = 60_000;
  private readonly threshold = Number(process.env.CHOIR_USAGE_ALERT_THRESHOLD ?? '30');
  private readonly usernameKeywords = process.env.CHOIR_USAGE_ALERT_KEYWORDS?.split(',').map(k => k.trim()) ?? ['(CHOIR)'];
  private readonly targetMethods = new Set([
    'chat.postMessage',
    'chat.update',
    'chat.delete',
  ]);

  // 요청 컨텍스트(행위자 ID) 저장
  private static readonly als = new AsyncLocalStorage<ActorContext>();

  private static apiCallPatched = false;

  public static getInstance(): SlackUsageMonitor {
    if (!this.instance) this.instance = new SlackUsageMonitor();
    return this.instance;
  }

  public static runWithActor<T>(userId: string | undefined, fn: () => Promise<T> | T): Promise<T> | T {
    return this.als.run({ userId }, fn);
  }

  public static getCurrentActor(): string | undefined {
    return this.als.getStore()?.userId;
  }

  /** 전역 apiCall 패치 (1회) */
  public initializeGlobalHook(): void {
    if (SlackUsageMonitor.apiCallPatched) return;

    const originalApiCall = (WebClient.prototype as any).apiCall;
    if (typeof originalApiCall !== 'function') {
      Logger.warn('SlackUsageMonitor: WebClient.prototype.apiCall not found; monitoring disabled');
      return;
    }

    const monitor = this;
    (WebClient.prototype as any).apiCall = async function patchedApiCall(
      method: string,
      options?: any,
    ): Promise<any> {
      try {
        if (monitor.targetMethods.has(method)) {
          await monitor.recordApiCall(this as WebClient, method, options);
        }
      } catch (e) {
        // 모니터링 실패는 본 호출 실패로 전파하지 않음
        Logger.error('SlackUsageMonitor record failed', e as Error, { method });
      }
      return originalApiCall.call(this, method, options);
    };

    SlackUsageMonitor.apiCallPatched = true;
    Logger.info('SlackUsageMonitor: WebClient apiCall hooked');
  }

  private getWindowStart(timestampMs: number): number {
    return Math.floor(timestampMs / this.windowMs) * this.windowMs;
  }

  private counterKey(workspaceId: string, actorId: string, windowStartMs: number): string {
    return `${workspaceId}:${actorId}:${windowStartMs}`;
  }

  private notifiedKey(workspaceId: string, actorId: string, windowStartMs: number): string {
    return `notified:${workspaceId}:${actorId}:${windowStartMs}`;
  }

  private async recordApiCall(client: WebClient, method: string, _options?: any): Promise<void> {
    // 행위자: 우선 ALS 저장값, 없으면 options.user(일부 메서드에 존재) 우선 사용
    const alsActor = SlackUsageMonitor.getCurrentActor();
    const inferredActor: string | undefined = alsActor || _options?.user;
    if (!inferredActor) {
      // 행위자 불명인 경우는 카운트는 하되 알림은 보내지 않음
    }

    const workspaceId = await getWorkspaceId(client);
    const now = Date.now();
    const windowStart = this.getWindowStart(now);
    const actorId = inferredActor ?? 'unknown';

    const key = this.counterKey(workspaceId, actorId, windowStart);
    const current = this.usageCounters.get(key) ?? 0;
    const next = current + 1;
    this.usageCounters.set(key, next);

    if (inferredActor && next >= this.threshold) {
      const nKey = this.notifiedKey(workspaceId, actorId, windowStart);
      if (!this.notifiedWindows.has(nKey)) {
        this.notifiedWindows.add(nKey);
        await this.notifyKeywordUsers(client, workspaceId, actorId, next, windowStart);
      }
    }
  }

  private async getUsersWithKeywords(client: WebClient): Promise<string[]> {
    try {
      const result = await client.users.list({});
      if (!result.members) return [];

      const matchingUsers = result.members.filter(user => {
        if (!user.real_name && !user.profile?.display_name) return false;
        const name = (user.real_name || user.profile?.display_name || '').toLowerCase();
        return this.usernameKeywords.some(keyword => name.includes(keyword.toLowerCase()));
      });

      return matchingUsers.map(user => user.id).filter(Boolean) as string[];
    } catch (error) {
      Logger.error('Error getting users with keywords', error as Error);
      return [];
    }
  }

  private async notifyKeywordUsers(
    client: WebClient,
    workspaceId: string,
    actorId: string,
    count: number,
    windowStartMs: number,
  ): Promise<void> {
    try {
      const keywordUsers = await this.getUsersWithKeywords(client);
      if (!keywordUsers || keywordUsers.length === 0) return;

      const actorName = await getUserName(actorId, client);
      const windowStart = new Date(windowStartMs);
      const windowEnd = new Date(windowStartMs + this.windowMs - 1);

      const text = `⚠️ *Slack API Usage Alert*\n\nHigh API usage detected within 1-minute window:\n• *Method calls*: ${count} (chat.postMessage, chat.update, chat.delete)\n• *Actor*: ${actorName} (<@${actorId}>)\n• *Time window*: ${windowStart.toLocaleString()} ~ ${windowEnd.toLocaleString()}\n\nThis may indicate potential rate limiting issues. Consider reviewing the application's messaging patterns.`;

      await Promise.all(
        keywordUsers.map(async (userId) => {
          try {
            await client.chat.postMessage({
              channel: userId,
              text,
              unfurl_links: false,
              unfurl_media: false,
            });
          } catch (e) {
            Logger.error('Failed to notify keyword user about usage', e as Error, { userId });
          }
        }),
      );
    } catch (error) {
      Logger.error('SlackUsageMonitor notifyKeywordUsers failed', error as Error, { workspaceId, actorId });
    }
  }
}

/** Bolt 전역 미들웨어: 현재 요청의 행위자 ID를 ALS에 저장 */
export const usageMonitoringMiddleware = async ({ body, event, next }: any) => {
  const userId = extractUserIdFromPayload(body, event);
  await SlackUsageMonitor.runWithActor(userId, async () => {
    await next();
  });
};

function extractUserIdFromPayload(body: any, event: any): string | undefined {
  // Interactive (actions, views), shortcuts
  if (body?.user?.id) return body.user.id;
  if (typeof body?.user === 'string') return body.user;
  if (body?.user_id) return body.user_id;

  // Events
  if (event?.user) return event.user;
  if (body?.event?.user) return body.event.user;
  if (event?.item_user) return event.item_user;
  if (event?.message?.user) return event.message.user;

  return undefined;
}

