import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { Logger } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getChannelName, getManagers, getUserName, getWorkspaceId } from 'services/slack';
import { createMessageLink } from '../suggestions/suggest-updates';

/**
 * Handle "Pass Suggestion to Manager" button click
 */
export const sendUpdateSuggestionToManagerCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  let workspaceId: string;
  await ack();

  //response_url을 통해 ephemeral 메시지를 "제안됨" 상태로 업데이트
  try {
    if (body.response_url) {
      await fetch(body.response_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          replace_original: true,
          text: '✅ Update suggestion sent!',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '✅ *Update suggestion sent!*\nYour suggestion has been forwarded to the managers for review.',
              },
            },
          ],
        }),
      });
    }
  } catch (error) {
    logger.warn('Failed to update ephemeral message via response_url:', error);
  }

  try {
    const sessionId = body.actions[0].value;

    if (!sessionId) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Invalid session. Please try submitting your suggestion again.',
      });
      return;
    }

    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Session data not found. Please try submitting your suggestion again.',
      });
      return;
    }

    workspaceId = await getWorkspaceId(client);
    const managers = await getManagers(workspaceId);

    if (managers.length === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ No managers found in this workspace. Please contact an administrator.',
      });
      return;
    }

    const userInfo = await client.users.info({ user: body.user.id });
    // Ensure userName is fetched correctly, fallback to a generic term if needed.
    const userName =
      userInfo.user?.profile?.display_name || userInfo.user?.real_name || userInfo.user?.name || 'A team member';

    sessionData.userId = body.user.id;
    sessionData.userName = userName; // 세션 데이터에도 사용자 이름 저장 (취소 등 다른 액션에서 사용 가능)

    if (!sessionData.managerMessageInfo) {
      sessionData.managerMessageInfo = {};
    }

    // CHOIR의 메시지 템플릿
    const choirGreeting = `Hi there! I'm CHOIR, your friendly documentation assistant. 👋\n\n*${userName}* has a suggestion for updating our documents, and I'm helping to pass it along for review.`;

    for (const managerId of managers) {
      try {
        let originalMessageLinkBlock = null;
        let messageLink = '';
        try {
          const conversationInfo = await client.conversations.info({ channel: sessionData.originalChannelId });
          if (
            conversationInfo.ok &&
            conversationInfo.channel &&
            (!conversationInfo.channel.is_private || conversationInfo.channel.is_member)
          ) {
            const authInfo = await client.auth.test();
            const workspaceUrl = authInfo.url;
            if (workspaceUrl) {
              messageLink = createMessageLink(
                workspaceUrl,
                sessionData.originalChannelId,
                sessionData.originalThreadTs,
              );
              originalMessageLinkBlock = {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `📍 <${messageLink}|View original discussion> for context`,
                },
              };
            }
          }
        } catch (linkError) {
          logger.warn(
            `Could not create original message link for channel ${sessionData.originalChannelId}:`,
            linkError,
          );
        }

        if (messageLink) {
          sessionData.originalMessageLink = messageLink;
        }

        // Combined message: Suggestion content + Action buttons
        const blocks: any[] = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: choirGreeting,
            },
          },
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '📝 Document Update Suggestion',
              emoji: true,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*From:* *${userName}*`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Suggestion:*\n\`\`\`${sessionData.extractedKnowledge}\`\`\``,
            },
          },
        ];

        if (originalMessageLinkBlock) {
          blocks.push(originalMessageLinkBlock);
        }

        blocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button' as const,
              text: {
                type: 'plain_text' as const,
                text: '✏️ Edit Suggestion',
                emoji: true,
              },
              action_id: 'open_knowledge_edit_manager_modal',
              value: sessionId,
            },
            {
              type: 'button' as const,
              text: {
                type: 'plain_text' as const,
                text: '🚀 Start Update Process',
                emoji: true,
              },
              style: 'primary' as const,
              action_id: 'suggest_updates',
              value: JSON.stringify({
                sessionId: sessionId,
                originalChannelId: sessionData.originalChannelId,
                originalThreadTs: sessionData.originalThreadTs,
              }),
            },
            {
              type: 'button' as const,
              text: {
                type: 'plain_text' as const,
                text: 'Decline',
                emoji: false,
              },
              style: 'danger' as const,
              action_id: 'cancel_knowledge_extraction',
              value: sessionId,
            },
          ],
        });

        const postedMessage = await client.chat.postMessage({
          channel: managerId,
          text: `📝 New document update suggestion from *${userName}* for your review.`,
          blocks: blocks,
          unfurl_links: false,
          unfurl_media: false,
        });

        // Store manager message info for later updates
        sessionData.managerMessageInfo[managerId] = {
          channel: managerId,
          ts: postedMessage.ts, // Combined message
        };

        storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE);

        // 로그: 매니저 알림 성공
        await logButtonClick(
          body.user.id,
          workspaceId,
          body.channel?.id || 'dm',
          'dm',
          'send_update_suggestion_to_manager',
          Date.now() - startTime,
          true,
          {
            sessionId,
            managersNotified: managers.length,
            managerIds: managers,
            extractedKnowledgeLength: sessionData.extractedKnowledge?.length || 0,
            originalChannelId: sessionData.originalChannelId,
            originalThreadTs: sessionData.originalThreadTs,
            userName,
          },
          client,
        );

        logger.info(`Update suggestion sent to ${managers.length} managers for session ${sessionId}`);
      } catch (error) {
        logger.error(`Failed to send suggestion to manager ${managerId}:`, error);
      }
    }

    // 원래 채널에 알림 메시지 전송
    if (sessionData.originalChannelId) {
      const originalChannelName = await getChannelName(sessionData.originalChannelId, client);

      // 매니저 이름 목록을 볼드체로 변환
      const managerNames = await Promise.all(managers.map((id: string) => getUserName(id, client)));
      const managerNamesBold = managerNames.map((name: string) => `*${name}*`).join(', ');

      await client.chat.postMessage({
        channel: sessionData.originalChannelId,
        text: `✅ Great news, *${userName}*! Your document update suggestion has been successfully sent to our manager(s): ${managerNamesBold}. They'll review it soon! (Sent from channel: #${originalChannelName})`,
        thread_ts: sessionData.originalThreadTs,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ Great news, *${userName}*! Your document update suggestion has been successfully sent to our manager(s): ${managerNamesBold}. They'll review it soon!`,
            },
          },
        ],
        unfurl_links: false,
        unfurl_media: false,
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Your update suggestion has been passed to ${managers.length} manager(s) for review. They will be able to apply the suggestion to update documents or provide feedback.`,
      });
    }

    logger.info(`Update suggestion passed to managers by *${userName}* (ID: ${body.user.id}) for session ${sessionId}`);
  } catch (error) {
    logger.error('Error sending update suggestion to managers:', error);

    // 로그: 매니저 알림 실패
    try {
      const workspaceIdForLog = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceIdForLog,
        body.channel?.id || 'dm',
        'dm',
        'send_update_suggestion_to_manager',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          sessionId: body.actions[0].value,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log button click error:', logError);
    }

    await client.chat.postMessage({
      channel: body.user.id,
      text: '❌ Failed to send your suggestion to managers. Please try again later.',
    });
  }
};
