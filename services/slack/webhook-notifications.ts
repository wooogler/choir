import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { tForUser } from 'services/i18n';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { DEFAULT_LOCALE, type T, createT } from '../../src/i18n';
import { getWorkspaceId } from './user-management';

/**
 * The two faces of one notification: `text` is Slack's plain notification
 * preview (no mrkdwn, no links), `blockText` the message body.
 */
interface NotificationParts {
  text: string;
  blockText: string;
}

/**
 * A webhook fan-out has no actor, so each manager is its own recipient and gets
 * their own language — which is why the strings are built per manager rather
 * than once by the caller.
 */
type BuildNotification = (t: T) => NotificationParts;

/**
 * A language is a presentation detail: failing to resolve one is a reason to
 * speak English, never a reason to drop a manager's notification.
 */
async function translatorFor(workspaceId: string | undefined, managerId: string, client: WebClient): Promise<T> {
  if (!workspaceId) return createT(DEFAULT_LOCALE);
  try {
    // `client` is passed because a manager who has never interacted with CHOIR
    // has no cached Slack locale, and this path is already off the hot path.
    return await tForUser(workspaceId, managerId, client);
  } catch (error) {
    Logger.warn('Failed to resolve a manager locale (falling back to the default)', {
      managerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return createT(DEFAULT_LOCALE);
  }
}

async function postManagerNotification(
  client: WebClient,
  managerIds: string[],
  build: BuildNotification,
  messageType: CHOIRMessageType,
): Promise<void> {
  const workspaceId = await getWorkspaceId(client).catch(() => undefined);

  // Deliver to each manager independently: a single deactivated or DM-blocked
  // manager must not abort the remaining notifications — nor the webhook
  // auto-reload flow that awaits these calls.
  await Promise.all(
    managerIds.map(async (managerId) => {
      try {
        const { text, blockText } = build(await translatorFor(workspaceId, managerId, client));
        await client.chat.postMessage({
          channel: managerId,
          text,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: blockText,
              },
              block_id: createCHOIRBlockId(messageType),
            },
          ],
        });
      } catch (error) {
        Logger.warn('Failed to notify a manager (continuing with the rest)', {
          managerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}

export async function notifyDocumentAutoReloadStarted(client: WebClient, managerIds: string[]): Promise<void> {
  await postManagerNotification(
    client,
    managerIds,
    (t) => {
      const text = t('notifications.webhook.started');
      return { text, blockText: text };
    },
    CHOIRMessageType.STATUS_UPDATE,
  );
}

export async function notifyDocumentAutoReloadNoDocuments(
  client: WebClient,
  managerIds: string[],
  repositoryUrl: string,
): Promise<void> {
  await postManagerNotification(
    client,
    managerIds,
    (t) => ({
      text: t('notifications.webhook.noDocuments'),
      blockText: t('notifications.webhook.noDocuments.detail', {
        repositoryLink: `<${repositoryUrl}|${t('notifications.link.viewRepository')}>`,
      }),
    }),
    CHOIRMessageType.RESPONSE,
  );
}

export async function notifyDocumentAutoReloadSucceeded(
  client: WebClient,
  managerIds: string[],
  fileCount: number,
  linkUrl: string,
  linkText: string,
): Promise<void> {
  await postManagerNotification(
    client,
    managerIds,
    (t) => ({
      // The preview cannot render a link, so it carries the bare label.
      text: t('notifications.webhook.succeeded', { count: fileCount, link: linkText }),
      blockText: t('notifications.webhook.succeeded', { count: fileCount, link: `<${linkUrl}|${linkText}>` }),
    }),
    CHOIRMessageType.SUCCESS,
  );
}

export async function notifyDocumentAutoReloadProcessingFailed(
  client: WebClient,
  managerIds: string[],
  repositoryUrl: string,
): Promise<void> {
  await postManagerNotification(
    client,
    managerIds,
    (t) => ({
      text: t('notifications.webhook.processingFailed'),
      blockText: t('notifications.webhook.processingFailed.detail', {
        repositoryLink: `<${repositoryUrl}|${t('notifications.link.viewRepository')}>`,
      }),
    }),
    CHOIRMessageType.RESPONSE,
  );
}

export async function notifyDocumentAutoReloadSystemError(
  client: WebClient,
  managerIds: string[],
  repositoryUrl: string,
): Promise<void> {
  await postManagerNotification(
    client,
    managerIds,
    (t) => ({
      text: t('notifications.webhook.systemError'),
      blockText: t('notifications.webhook.systemError.detail', {
        repositoryLink: `<${repositoryUrl}|${t('notifications.link.viewRepository')}>`,
      }),
    }),
    CHOIRMessageType.RESPONSE,
  );
}
