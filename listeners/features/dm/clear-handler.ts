import { logMessageProcessing } from 'services/common/interaction-tracker';
import { getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

/**
 * DM에서 CHOIR 메시지 clear 처리
 */
export async function handleDMClearCommand(client: any, event: any, logger: any) {
  const startTime = Date.now();

  try {
    // DM이 아닌 경우 처리하지 않음
    if (event.channel_type !== 'im') {
      return false;
    }

    logger.info(`Clear command initiated by user ${event.user} in DM ${event.channel}`);

    // Bot 정보 가져오기
    const botInfo = await client.auth.test();
    const botUserId = botInfo.user_id;

    // DM 히스토리 가져오기 (최근 100개 메시지)
    const historyResponse = await client.conversations.history({
      channel: event.channel,
      limit: 100,
    });

    if (!historyResponse.messages) {
      await client.chat.postMessage({
        channel: event.channel,
        text: '💬 No messages found to clear.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '💬 No messages found to clear.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
          },
        ],
      });
      return true;
    }

    // CHOIR가 보낸 메시지만 필터링 (bot_id 또는 user가 botUserId인 메시지)
    const choirMessages = historyResponse.messages.filter(
      (msg: any) => msg.user === botUserId || msg.bot_id === botUserId,
    );

    // Thread reply도 포함하여 CHOIR 메시지 수집
    const allChoirMessages = [...choirMessages];

    // 각 메시지에 대해 thread reply 확인
    for (const message of historyResponse.messages) {
      if (message.thread_ts && message.reply_count && message.reply_count > 0) {
        try {
          const repliesResponse = await client.conversations.replies({
            channel: event.channel,
            ts: message.thread_ts,
            limit: 100, // thread reply는 보통 많지 않으므로 100개로 제한
          });

          if (repliesResponse.messages) {
            // thread reply 중 CHOIR가 보낸 메시지만 추가
            const choirReplies = repliesResponse.messages.filter(
              (reply: any) =>
                (reply.user === botUserId || reply.bot_id === botUserId) &&
                reply.ts !== message.thread_ts && // 원본 메시지는 이미 포함되어 있음
                !allChoirMessages.some((existing: any) => existing.ts === reply.ts), // 중복 제거
            );

            allChoirMessages.push(...choirReplies);
          }
        } catch (error) {
          logger.warn(`Failed to fetch replies for thread ${message.thread_ts}:`, error);
        }
      }
    }

    // 시간순으로 정렬 (최신 메시지가 먼저 오도록)
    allChoirMessages.sort((a: any, b: any) => Number.parseFloat(b.ts) - Number.parseFloat(a.ts));

    // 최근 5개 메시지만 선택
    const messagesToClear = allChoirMessages.slice(0, 5);

    if (messagesToClear.length === 0) {
      await client.chat.postMessage({
        channel: event.channel,
        text: '💬 No CHOIR messages found to clear.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '💬 No CHOIR messages found to clear.\n\n_Note: Only CHOIR messages can be deleted. User messages cannot be removed by the bot._',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
          },
        ],
      });
      return true;
    }

    // 확인 메시지 전송
    const confirmMessage = await client.chat.postMessage({
      channel: event.channel,
      text: `🗑️ Are you sure you want to clear ${messagesToClear.length} recent CHOIR messages?`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🗑️ *Clear Recent CHOIR Messages*\n\nI found ${allChoirMessages.length} total CHOIR messages in this conversation. I will delete the ${messagesToClear.length} most recent ones.\n\nAre you sure you want to delete them? This action cannot be undone.`,
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: `Yes, Clear ${messagesToClear.length} Recent`,
                emoji: true,
              },
              style: 'danger',
              action_id: 'confirm_clear_dm',
              value: JSON.stringify({
                messageCount: messagesToClear.length,
                messageTimestamps: messagesToClear.map((msg: any) => msg.ts),
              }),
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Cancel',
                emoji: true,
              },
              action_id: 'cancel_clear_dm',
            },
          ],
        },
      ],
    });

    // 로그 기록
    const workspaceId = await getWorkspaceId(client);
    await logMessageProcessing(
      event.user,
      workspaceId,
      event.channel,
      'dm',
      false,
      Date.now() - startTime,
      true,
      'clear',
      'clear_command',
      {
        choirMessagesFound: allChoirMessages.length,
        messagesToClear: messagesToClear.length,
        totalMessagesChecked: historyResponse.messages.length,
      },
      client,
    );

    logger.info(
      `Clear confirmation shown for ${messagesToClear.length} recent CHOIR messages (out of ${allChoirMessages.length} total) in DM ${event.channel}`,
    );
    return true;
  } catch (error) {
    logger.error('Error in handleDMClearCommand:', error);

    // 실패 로그
    try {
      const workspaceId = await getWorkspaceId(client);
      await logMessageProcessing(
        event.user,
        workspaceId,
        event.channel,
        'dm',
        false,
        Date.now() - startTime,
        false,
        'clear',
        'clear_command',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log clear command error:', logError);
    }

    await client.chat.postMessage({
      channel: event.channel,
      text: '❌ Sorry, I encountered an error while trying to clear the chat. Please try again.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '❌ Sorry, I encountered an error while trying to clear the chat. Please try again.',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
        },
      ],
    });

    return false;
  }
}
