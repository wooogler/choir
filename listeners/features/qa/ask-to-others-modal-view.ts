import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData, trackAnonymousMessage } from 'services/common';
import { createPrivateMessage, createPrivateMessagePreview, getUserName, getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { logModalSubmit } from '../../../services/common/user-interaction-logger';

/**
 * 멤버 선택 모달 제출 처리
 */
export const askToOthersSubmitCallback = async ({
  ack,
  body,
  view,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  const startTime = Date.now();
  await ack();

  try {
    const sessionId = view.private_metadata;
    const selectedUsers = view.state.values.users_select.users.selected_users;
    const isAnonymous =
      (view.state.values.anonymous_select?.anonymous_checkbox_private?.selected_options?.length || 0) > 0;
    const userComment = view.state.values.user_comment?.comment_text?.value || '';
    const userId = body.user.id;

    if (!sessionId || !selectedUsers || selectedUsers.length === 0) {
      // 로그: 필수 데이터 없음
      const workspaceId = await getWorkspaceId(client);
      logModalSubmit(
        userId,
        workspaceId,
        'ask_to_others_submit',
        Date.now() - startTime,
        false,
        {
          error: 'Missing sessionId or selectedUsers',
          sessionId,
          selectedUsersCount: selectedUsers?.length || 0,
        },
        client,
        'modal',
        'dm',
      );
      return;
    }

    const currentWorkspaceId = await getWorkspaceId(client);

    // 세션 데이터 가져오기
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      // 로그: 세션 데이터 없음
      const workspaceId = await getWorkspaceId(client);
      logModalSubmit(
        userId,
        workspaceId,
        'ask_to_others_submit',
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

    // DM 참여자 결정: anonymous가 아닌 경우 질문자도 포함
    const dmParticipants = isAnonymous ? selectedUsers : [userId, ...selectedUsers];

    // 변수 선언
    let successCount = 0;
    let failCount = 0;
    let conversationId = '';
    const participantNames: string[] = [];

    try {
      // 참여자 이름들 가져오기
      for (const participantId of dmParticipants) {
        try {
          const name = await getUserName(participantId, client);
          participantNames.push(name);
        } catch (error) {
          logger.warn(`Failed to get user name for ${participantId}:`, error);
          participantNames.push(`<@${participantId}>`);
        }
      }

      // 그룹 DM 생성 (참여자가 2명 이상인 경우) 또는 개별 DM (1명인 경우)
      if (dmParticipants.length === 1) {
        // 1명인 경우 개별 DM - 실제 DM 채널 ID 가져오기
        const conversation = await client.conversations.open({
          users: dmParticipants[0],
        });
        conversationId = conversation.channel?.id || '';
      } else {
        // 2명 이상인 경우 그룹 DM 생성
        const conversation = await client.conversations.open({
          users: dmParticipants.join(','),
        });
        conversationId = conversation.channel?.id || '';
      }

      if (conversationId) {
        // 공통 함수를 사용해 메시지 블록 생성 (anonymous 옵션 포함)
        const messageBlocks = createPrivateMessage(
          conversationId,
          userId,
          sessionData.originalQuestion,
          sessionData.botResponse,
          true, // canAnswer - assume true for private sharing
          isAnonymous,
          userName,
          sessionId, // sessionId 전달
          userComment,
        );

        // Create comprehensive text that matches the blocks content for conversation history
        const messageText = createPrivateMessagePreview(
          'team member', // recipientName - generic since it could be multiple people
          userName,
          sessionData.originalQuestion,
          sessionData.botResponse,
          true, // canAnswer - assume true for private sharing
          isAnonymous,
          userComment,
        );

        const postedMessage = await client.chat.postMessage({
          channel: conversationId,
          text: messageText,
          blocks: messageBlocks,
        });

        // Anonymous 질문인 경우 메시지 추적 등록 및 CHOIR의 안내 메시지 추가
        if (isAnonymous && postedMessage.ts) {
          trackAnonymousMessage(conversationId, postedMessage.ts, userId, sessionId, currentWorkspaceId);
          logger.info('Anonymous message tracked', {
            workspaceId: currentWorkspaceId,
            conversationId,
            messageTs: postedMessage.ts,
            originalQuestionerId: userId,
            sessionId,
          });

          // CHOIR이 thread에 안내 메시지 추가
          await client.chat.postMessage({
            channel: conversationId,
            thread_ts: postedMessage.ts,
            text: 'Feel free to discuss this question in this thread! Your responses will be automatically shared with the anonymous questioner.',
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: "👋 Feel free to discuss this question in this thread!\n\n💡 *Your responses will be automatically shared with the anonymous questioner.*\n\n🤖 *Need CHOIR to help?* Just mention me with `@choir` and I'll join the discussion!",
                },
                block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
              },
            ],
          });
        }

        successCount = 1;
        failCount = 0;
      } else {
        throw new Error('Failed to create conversation');
      }
    } catch (error) {
      logger.error(`Failed to send private Q&A to group DM:`, error);
      successCount = 0;
      failCount = 1;
    }

    // 사용자에게 성공 메시지 전송 (원본 채널이 있는 경우)
    if (sessionData.originalChannelId && successCount > 0) {
      // 참여자 이름들 표시
      const participantsList = participantNames.join(', ');

      logger.info('[DEBUG] Sending "Private DM created" public message:', {
        channel: sessionData.originalChannelId,
        thread_ts: sessionData.originalThreadTs,
        hasThreadTs: !!sessionData.originalThreadTs,
        participantsList,
      });

      // 공통 성공 메시지 (원본 스레드에 공개)
      await client.chat.postMessage({
        channel: sessionData.originalChannelId,
        ...(sessionData.originalThreadTs ? { thread_ts: sessionData.originalThreadTs } : {}),
        text: `✅ Private DM created with: ${participantsList}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ *Private DM created*\n📋 Participants: ${participantsList}`,
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
          },
        ],
      });

      // Anonymous가 아닌 경우에만 질문자에게 Open DM 버튼 제공 (ephemeral)
      if (!isAnonymous) {
        // 팀 ID 가져오기 (DM 링크용)
        const authInfo = await client.auth.test();
        const teamId = authInfo.team_id;

        logger.info('[DEBUG] Sending "Your private DM is ready" ephemeral message:', {
          channel: sessionData.originalChannelId,
          user: userId,
          thread_ts: sessionData.originalThreadTs,
          hasThreadTs: !!sessionData.originalThreadTs,
        });

        await client.chat.postEphemeral({
          channel: sessionData.originalChannelId,
          user: userId,
          ...(sessionData.originalThreadTs ? { thread_ts: sessionData.originalThreadTs } : {}),
          text: 'Access your private DM',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '💬 *Your private DM is ready*\nClick the button below to open the conversation.',
              },
              block_id: createCHOIRBlockId(CHOIRMessageType.EPHEMERAL_HELPER),
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: 'Open DM',
                    emoji: true,
                  },
                  style: 'primary',
                  action_id: 'open_private_dm_url',
                  url: `slack://channel?team=${teamId}&id=${conversationId}`,
                },
              ],
            },
          ],
        });
      }
    }

    logger.info(`Private Q&A sent to ${selectedUsers.length} users by user ${userId}`);

    // 로그: 성공
    const workspaceId = await getWorkspaceId(client);
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
      'ask_to_others_submit',
      Date.now() - startTime,
      true,
      {
        sessionId,
        selectedUsersCount: selectedUsers.length,
        selectedUsers: selectedUsers,
        selectedUserNames: participantNames,
        successCount,
        failCount,
        isAnonymous,
        userComment,
        originalChannelId: sessionData.originalChannelId,
        originalThreadTs: sessionData.originalThreadTs,
        question: sessionData.originalQuestion,
        questionLength: sessionData.originalQuestion?.length || 0,
        response: sessionData.botResponse,
        responseLength: sessionData.botResponse?.length || 0,
      },
      client,
      actualChannelId,
      actualChannelType,
    );
  } catch (error) {
    logger.error('Error submitting member selection:', error);

    // 로그: 실패
    try {
      const workspaceId = await getWorkspaceId(client);
      logModalSubmit(
        body.user.id,
        workspaceId,
        'ask_to_others_submit',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          sessionId: view.private_metadata,
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
