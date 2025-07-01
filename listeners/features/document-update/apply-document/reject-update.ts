import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import {
  deleteLastMessageTimestamp,
  deleteProgressMessageTimestamp,
  getLastMessageTimestamp,
  getProgressMessageTimestamp,
} from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { removeDocumentUpdate } from 'services/document/document-store';
import { getWorkspaceId } from 'services/slack';
import suggestUpdatesCallback from '../suggestions/suggest-updates';

/**
 * 문서 업데이트 제안을 거절하고 다음 제안을 보여주는 핸들러
 */
export const rejectUpdateCallback = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const userId = body.user.id;
    const dmChannelId = body.channel?.id;

    if (!dmChannelId) {
      throw new Error('채널 ID를 찾을 수 없습니다');
    }

    // value 파싱
    const value = body.actions?.[0]?.value;
    if (!value) {
      throw new Error('버튼 값을 찾을 수 없습니다');
    }

    const parsedValue = JSON.parse(value);
    const { index, messageKeys, originalChannelId, originalThreadTs, rejectIndex } = parsedValue;

    // 이전 메시지 삭제 (저장된 타임스탬프 사용)
    const lastMessageTs = getLastMessageTimestamp(userId);
    if (lastMessageTs) {
      try {
        await client.chat.delete({
          channel: dmChannelId,
          ts: lastMessageTs,
        });
        // 삭제 성공 시 타임스탬프 제거
        deleteLastMessageTimestamp(userId);
      } catch (error) {
        console.error('이전 메시지 삭제 실패:', error);
        // 삭제 실패해도 타임스탬프는 제거 (다음에 다시 시도하지 않도록)
        deleteLastMessageTimestamp(userId);
      }
    }

    // 진행 중 메시지도 삭제
    const progressTs = getProgressMessageTimestamp(userId);
    if (progressTs) {
      try {
        await client.chat.delete({
          channel: dmChannelId,
          ts: progressTs,
        });
        deleteProgressMessageTimestamp(userId);
      } catch (error) {
        console.error('진행 중 메시지 삭제 실패:', error);
        deleteProgressMessageTimestamp(userId);
      }
    }

    // document update 삭제
    removeDocumentUpdate(userId, rejectIndex);

    // 다음 제안 보여주기
    await suggestUpdatesCallback({
      ack: async () => {},
      body: {
        user: { id: userId },
        channel: { id: dmChannelId },
        actions: [
          {
            value: JSON.stringify({
              index,
              messageKeys,
              originalChannelId,
              originalThreadTs,
            }),
          },
        ],
        container: { thread_ts: originalThreadTs },
      },
      client,
    } as any);

    // 로그: 성공
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      userId,
      workspaceId,
      dmChannelId,
      'dm',
      'reject_update',
      Date.now() - startTime,
      true,
      {
        index,
        rejectIndex,
        originalChannelId,
        originalThreadTs,
        lastMessageDeleted: !!lastMessageTs,
        progressMessageDeleted: !!progressTs,
        messageKeysCount: messageKeys?.length || 0,
      },
      client,
    );
  } catch (error) {
    console.error('업데이트 거절 처리 중 오류 발생:', error);

    const channelId = body.channel?.id;
    if (channelId) {
      const errorMessage = error instanceof Error ? error.message : '알 수 없는 오류';
      await client.chat.postMessage({
        channel: channelId,
        text: `업데이트 거절 처리 중 오류가 발생했습니다: ${errorMessage}`,
      });
    }

    // 로그: 실패
    try {
      const workspaceIdForError = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceIdForError,
        body.channel?.id || 'dm',
        'dm',
        'reject_update',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          buttonValue: body.actions?.[0]?.value,
        },
        client,
      );
    } catch (logError) {
      console.error('Failed to log reject_update error:', logError);
    }
  }
};
