import { logMessageProcessing } from 'services/common/interaction-tracker';
import { type Locale, resolveLocaleForUserCached } from 'services/i18n';
import { getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { DEFAULT_LOCALE, type T, createT } from '../../../src/i18n';

/**
 * DM에서 CHOIR 메시지 clear 처리
 *
 * Like `handleQuestionMessage`, this is called straight from the message
 * router rather than registered with Bolt, so it takes the asker's language as
 * an optional argument and resolves it itself when the router has none.
 */
export async function handleDMClearCommand(client: any, event: any, logger: any, locale?: Locale) {
  const startTime = Date.now();
  // Assigned once the workspace is known; the catch below needs a translator
  // even if that lookup is what failed.
  let t: T = createT(DEFAULT_LOCALE);

  try {
    // DM이 아닌 경우 처리하지 않음
    if (event.channel_type !== 'im') {
      return false;
    }

    const workspaceId = await getWorkspaceId(client);
    t = createT(locale ?? (await resolveLocaleForUserCached(workspaceId, event.user)));

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
        text: t('dm.clear.noMessages'),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('dm.clear.noMessages'),
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

    // We only ever clear the 5 most recent CHOIR messages. conversations.replies
    // is heavily rate-limited (~1 req/min), so only dig into threads if the
    // top-level messages don't already provide enough, and cap the number of
    // reply fetches — scanning the most recent threads first.
    const NEEDED_CHOIR_MESSAGES = 5;
    const MAX_REPLY_FETCHES = 5;
    if (allChoirMessages.length < NEEDED_CHOIR_MESSAGES) {
      const threadParents = historyResponse.messages
        .filter((msg: any) => msg.thread_ts && msg.reply_count && msg.reply_count > 0)
        .sort((a: any, b: any) => Number.parseFloat(b.ts) - Number.parseFloat(a.ts))
        .slice(0, MAX_REPLY_FETCHES);

      for (const message of threadParents) {
        if (allChoirMessages.length >= NEEDED_CHOIR_MESSAGES) break;
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
        text: t('dm.clear.noChoirMessages.text'),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('dm.clear.noChoirMessages'),
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
      text: t('dm.clear.confirm.text', { count: messagesToClear.length }),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('dm.clear.confirm', {
              total: allChoirMessages.length,
              count: messagesToClear.length,
            }),
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
                text: t('dm.clear.confirm.button', { count: messagesToClear.length }),
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
                text: t('common.button.cancel'),
                emoji: true,
              },
              action_id: 'cancel_clear_dm',
            },
          ],
        },
      ],
    });

    // 로그 기록
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
      text: t('dm.clear.error'),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('dm.clear.error'),
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
        },
      ],
    });

    return false;
  }
}
