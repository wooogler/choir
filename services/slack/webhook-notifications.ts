import type { WebClient } from '@slack/web-api';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

async function postManagerNotification(
  client: WebClient,
  managerIds: string[],
  text: string,
  blockText: string,
  messageType: CHOIRMessageType,
): Promise<void> {
  for (const managerId of managerIds) {
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
  }
}

export async function notifyDocumentAutoReloadStarted(client: WebClient, managerIds: string[]): Promise<void> {
  const text = '🔄 Reflecting your document changes...';

  await postManagerNotification(client, managerIds, text, text, CHOIRMessageType.STATUS_UPDATE);
}

export async function notifyDocumentAutoReloadNoDocuments(
  client: WebClient,
  managerIds: string[],
  repositoryUrl: string,
): Promise<void> {
  await postManagerNotification(
    client,
    managerIds,
    '❌ Unable to reflect changes: No documents found.',
    `❌ Unable to reflect changes: No documents found. <${repositoryUrl}|View Repository>`,
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
    `✅ Document changes reflected successfully! Updated ${fileCount} files. ${linkText}`,
    `✅ Document changes reflected successfully! Updated ${fileCount} files. <${linkUrl}|${linkText}>`,
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
    '❌ Unable to reflect changes: Processing failed.',
    `❌ Unable to reflect changes: Processing failed. Try "Reload From Github" in Home or contact research team. <${repositoryUrl}|View Repository>`,
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
    '❌ Unable to reflect document changes: System error occurred.',
    `❌ Unable to reflect document changes: System error occurred. Try "Reload From Github" in Home or contact research team. <${repositoryUrl}|View Repository>`,
    CHOIRMessageType.RESPONSE,
  );
}
