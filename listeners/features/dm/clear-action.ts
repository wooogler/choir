import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

/**
 * DM Clear 확인 버튼 처리
 */
export const confirmClearDMCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const actionValue = JSON.parse(body.actions[0].value || '{}');
    const { messageCount, messageTimestamps } = actionValue;

    if (!messageTimestamps || !Array.isArray(messageTimestamps)) {
      throw new Error('Invalid message timestamps data');
    }

    logger.info(`Starting to clear ${messageCount} recent messages in DM ${body.channel?.id}`);

    // 확인 메시지 업데이트 (진행 상태 표시)
    await client.chat.update({
      channel: body.channel?.id || '',
      ts: body.message?.ts || '',
      text: '🗑️ Clearing recent messages...',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🗑️ *Clearing ${messageCount} recent messages...*\nPlease wait while I delete the messages.`,
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
        },
      ],
    });

    let deletedCount = 0;
    let failedCount = 0;

    // 메시지들을 하나씩 삭제 (API 제한 고려하여 순차 처리)
    for (const timestamp of messageTimestamps) {
      try {
        await client.chat.delete({
          channel: body.channel?.id || '',
          ts: timestamp,
        });
        deletedCount++;

        // API 제한 방지를 위한 짧은 지연
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (deleteError) {
        logger.warn(`Failed to delete message ${timestamp}:`, deleteError);
        failedCount++;
      }
    }

    // 확인 메시지도 삭제
    try {
      await client.chat.delete({
        channel: body.channel?.id || '',
        ts: body.message?.ts || '',
      });
    } catch (error) {
      logger.warn('Failed to delete confirmation message:', error);
    }

    // 완료 메시지는 보내지 않음 (깔끔한 clear를 위해)

    // 로그 기록
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      body.user.id,
      workspaceId,
      body.channel?.id || '',
      'dm',
      'confirm_clear_dm',
      Date.now() - startTime,
      true,
      {
        totalMessages: messageCount,
        deletedCount,
        failedCount,
      },
      client,
    );

    logger.info(`Clear completed: ${deletedCount} deleted, ${failedCount} failed in DM ${body.channel?.id}`);
  } catch (error) {
    logger.error('Error in confirmClearDMCallback:', error);

    // 에러 메시지 업데이트
    try {
      await client.chat.update({
        channel: body.channel?.id || '',
        ts: body.message?.ts || '',
        text: '❌ Failed to clear messages',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ *Failed to clear messages*\nSorry, I encountered an error while clearing the chat. Please try again.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });
    } catch (updateError) {
      logger.warn('Failed to update error message:', updateError);
    }

    // 실패 로그
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || '',
        'dm',
        'confirm_clear_dm',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log clear error:', logError);
    }
  }
};

/**
 * DM Clear 취소 버튼 처리
 */
export const cancelClearDMCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    // 확인 메시지 삭제
    await client.chat.delete({
      channel: body.channel?.id || '',
      ts: body.message?.ts || '',
    });

    // 취소 메시지도 보내지 않음 (깔끔한 clear를 위해)

    // 로그 기록
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      body.user.id,
      workspaceId,
      body.channel?.id || '',
      'dm',
      'cancel_clear_dm',
      Date.now() - startTime,
      true,
      {},
      client,
    );

    logger.info(`Clear operation cancelled by user ${body.user.id} in DM ${body.channel?.id}`);
  } catch (error) {
    logger.error('Error in cancelClearDMCallback:', error);

    // 실패 로그
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || '',
        'dm',
        'cancel_clear_dm',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log cancel error:', logError);
    }
  }
};
