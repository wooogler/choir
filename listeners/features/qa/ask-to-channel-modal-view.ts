import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { tForRequest } from 'services/i18n';
import { createQAChannelMessage, createQAChannelPreview, getUserName, getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { logModalSubmit } from '../../../services/common/interaction-tracker';
import type { T } from '../../../src/i18n';

async function postQAChannelMessage(params: {
  client: any;
  qaChannelId: string;
  messageText: string;
  messageBlocks: any[];
  logger: any;
  t: T;
}) {
  const { client, qaChannelId, messageText, messageBlocks, logger, t } = params;

  try {
    return await client.chat.postMessage({
      channel: qaChannelId,
      text: messageText,
      blocks: messageBlocks,
    });
  } catch (error: any) {
    if (error?.data?.error !== 'not_in_channel') {
      throw error;
    }

    logger.warn(`Bot is not in Q&A channel ${qaChannelId}; attempting to join before posting.`);
    try {
      await client.conversations.join({ channel: qaChannelId });
    } catch (joinError: any) {
      if (joinError?.data?.error === 'missing_scope' && joinError?.data?.needed === 'channels:join') {
        throw new Error(t('qa.channelSubmit.notInChannel'));
      }
      throw joinError;
    }

    return await client.chat.postMessage({
      channel: qaChannelId,
      text: messageText,
      blocks: messageBlocks,
    });
  }
}

async function notifySubmitFailure(client: any, userId: string, message: string): Promise<void> {
  try {
    const dm = await client.conversations.open({ users: userId });
    await client.chat.postMessage({
      channel: dm.channel?.id || userId,
      text: message,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: message },
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
        },
      ],
    });
  } catch {
    // Keep the original submit error as the useful failure signal.
  }
}

/**
 * 채널 선택 모달 제출 처리
 */
export const askToChannelSubmitCallback = async ({
  ack,
  body,
  view,
  client,
  context,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  const startTime = Date.now();
  await ack();

  // Everything this handler says back is addressed to the submitter. What goes
  // *into* the Q&A channel follows the workspace's language instead, which
  // `createQAChannelMessage` / `createQAChannelPreview` resolve themselves.
  const t = tForRequest(context);

  try {
    const { sessionId, qaChannelId } = JSON.parse(view.private_metadata);
    const isAnonymous =
      (view.state.values.anonymous_select?.anonymous_checkbox_channel?.selected_options?.length || 0) > 0;
    const userComment = view.state.values.user_comment?.comment_text?.value || '';
    const userId = body.user.id;
    const workspaceId = await getWorkspaceId(client);

    if (!sessionId || !qaChannelId) {
      // 로그: 필수 데이터 없음
      logModalSubmit(
        userId,
        workspaceId,
        'ask_to_channel_submit',
        Date.now() - startTime,
        false,
        {
          error: 'Missing sessionId or qaChannelId',
          sessionId,
          qaChannelId,
        },
        client,
        'modal',
        'dm',
      );
      return;
    }

    // 세션 데이터 가져오기
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      // 로그: 세션 데이터 없음
      logModalSubmit(
        userId,
        workspaceId,
        'ask_to_channel_submit',
        Date.now() - startTime,
        false,
        {
          error: 'Session data not found',
          sessionId,
        },
        client,
        'modal',
        'dm',
      );
      return;
    }

    // 사용자 이름 가져오기
    const userName = await getUserName(userId, client);
    const canAnswer = sessionData.canAnswer ?? true;
    const question = sessionData.originalQuestion?.trim();
    const response = sessionData.botResponse?.trim();

    if (!question || (canAnswer && !response)) {
      throw new Error('Missing Q&A session question or response content');
    }

    // Q&A 채널 이름 가져오기
    let channelName = 'qna';
    try {
      const channelInfo = await client.conversations.info({ channel: qaChannelId });
      channelName = channelInfo.channel?.name || 'qna';
    } catch (error) {
      logger.warn(`Could not get Q&A channel name for ${qaChannelId}:`, error);
    }

    // 공통 함수를 사용해 메시지 블록 생성 (anonymous 옵션 포함)
    const messageBlocks = await createQAChannelMessage(
      channelName,
      userId,
      question,
      response || '',
      canAnswer,
      isAnonymous,
      userName,
      userComment,
      client,
      workspaceId,
    );

    // Create comprehensive text that matches the blocks content for conversation history
    const messageText = await createQAChannelPreview(
      channelName,
      userId,
      question,
      response || '',
      canAnswer,
      isAnonymous,
      userName,
      userComment,
      workspaceId,
    );

    // Q&A 채널에 메시지 전달
    const postedMessage = await postQAChannelMessage({
      client,
      qaChannelId,
      messageText,
      messageBlocks,
      logger,
      t,
    });

    // 사용자에게 성공 메시지 전송 (원본 채널이 있는 경우)
    if (sessionData.originalChannelId) {
      const postedText = t('qa.channelSubmit.posted', { channel: `<#${qaChannelId}>` });
      await client.chat.postMessage({
        channel: sessionData.originalChannelId,
        text: postedText,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: postedText,
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
          },
        ],
      });
    }

    logger.info(`Q&A posted to channel ${qaChannelId} by user ${userId}`, {
      messageTs: postedMessage.ts,
      canAnswer,
      isAnonymous,
    });

    // 로그: 성공
    // originalChannelId에서 채널 정보 추출
    const actualChannelId = sessionData.originalChannelId || 'modal';
    let actualChannelType: 'public' | 'private' | 'dm' = 'dm';
    try {
      if (sessionData.originalChannelId) {
        const channelInfo = await client.conversations.info({ channel: sessionData.originalChannelId });
        if (channelInfo.channel?.is_private) {
          actualChannelType = 'private';
        } else if (channelInfo.channel?.is_im) {
          actualChannelType = 'dm';
        } else {
          actualChannelType = 'public';
        }
      }
    } catch (channelInfoError) {
      logger.warn('Could not get channel info for logging:', channelInfoError);
    }
    logModalSubmit(
      userId,
      workspaceId,
      'ask_to_channel_submit',
      Date.now() - startTime,
      true,
      {
        sessionId,
        qaChannelId,
        qaChannelName: channelName,
        isAnonymous,
        userComment,
        originalChannelId: sessionData.originalChannelId,
        originalThreadTs: sessionData.originalThreadTs,
        question,
        questionLength: question.length,
        response,
        responseLength: response?.length || 0,
        canAnswer,
        postedMessageTs: postedMessage.ts,
      },
      client,
      actualChannelId,
      actualChannelType,
    );
  } catch (error) {
    logger.error('Error submitting channel selection:', error);
    await notifySubmitFailure(
      client,
      body.user.id,
      t('qa.channelSubmit.error', {
        reason: error instanceof Error ? error.message : t('qa.channelSubmit.errorReason'),
      }),
    );

    // 로그: 실패
    try {
      const workspaceId = await getWorkspaceId(client);
      logModalSubmit(
        body.user.id,
        workspaceId,
        'ask_to_channel_submit',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          privateMetadata: view.private_metadata,
        },
        client,
        'modal',
        'dm',
      );
    } catch (logError) {
      logger.warn('Failed to log error:', logError);
    }
  }
};
