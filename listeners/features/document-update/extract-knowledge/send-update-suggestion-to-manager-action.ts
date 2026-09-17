import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { Logger } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { logButtonClick } from 'services/common/interaction-tracker';
import { tForRequest, tForUser, tForWorkspace } from 'services/i18n';
import { getChannelName, getManagers, getUserName, getWorkspaceId } from 'services/slack';
import { createMessageLink } from '../suggestions/suggest-updates-handler';

/**
 * Handle "Pass Suggestion to Manager" button click
 */
export const sendUpdateSuggestionToManagerCallback = async ({
  ack,
  body,
  client,
  logger,
  context,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  let workspaceId: string;
  await ack();

  // The requester's own ephemeral and every failure notice; the manager cards
  // and the channel confirmation get their own translators.
  const t = tForRequest(context);

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
          text: t('docUpdate.extract.sent.ephemeral.fallback'),
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('docUpdate.extract.sent.ephemeral'),
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
        text: t('docUpdate.extract.error.invalidSessionSubmit'),
      });
      return;
    }

    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: t('docUpdate.extract.error.sessionMissingSubmit'),
      });
      return;
    }

    workspaceId = await getWorkspaceId(client);
    const managers = await getManagers(workspaceId);

    if (managers.length === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: t('docUpdate.extract.error.noManagers'),
      });
      return;
    }

    const userInfo = await client.users.info({ user: body.user.id });
    // Ensure userName is fetched correctly, fallback to a generic term if needed.
    const userName =
      userInfo.user?.profile?.display_name ||
      userInfo.user?.real_name ||
      userInfo.user?.name ||
      t('notifications.manager.suggestion.anonymousUser');

    sessionData.userId = body.user.id;
    sessionData.userName = userName; // 세션 데이터에도 사용자 이름 저장 (취소 등 다른 액션에서 사용 가능)

    if (!sessionData.managerMessageInfo) {
      sessionData.managerMessageInfo = {};
    }

    for (const managerId of managers) {
      try {
        // One translator per recipient: each manager gets the card in their own
        // language, not in the language of whoever sent the suggestion.
        const tManager = await tForUser(workspaceId, managerId, client);
        // CHOIR의 메시지 템플릿
        const choirGreeting = tManager('notifications.manager.suggestion.intro', { userName });

        let originalMessageLinkBlock = null;
        let messageLink = '';
        try {
          const conversationInfo = await client.conversations.info({ channel: sessionData.originalChannelId });
          if (
            conversationInfo.ok &&
            conversationInfo.channel &&
            conversationInfo.channel.is_channel &&
            !conversationInfo.channel.is_private
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
                  text: tManager('notifications.manager.suggestion.context', {
                    discussionLink: `<${messageLink}|${tManager('notifications.link.viewDiscussion')}>`,
                  }),
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

        // Create intro block with user profile image
        const introBlock: any = {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: choirGreeting,
          },
        };

        // Add user profile image if available
        if (sessionData.userId) {
          try {
            const userInfo = await client.users.info({ user: sessionData.userId });
            if (userInfo.user?.profile?.image_192) {
              introBlock.accessory = {
                type: 'image',
                image_url: userInfo.user.profile.image_192,
                alt_text: userName || tManager('docUpdate.extract.card.profileAlt'),
              };
            } else {
              // Fallback to default profile image
              introBlock.accessory = {
                type: 'image',
                image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
                alt_text: userName || tManager('docUpdate.extract.card.profileAlt'),
              };
            }
          } catch (error) {
            console.error('Error fetching user profile image:', error);
            // Fallback to default profile image on error
            introBlock.accessory = {
              type: 'image',
              image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
              alt_text: userName || tManager('docUpdate.extract.card.profileAlt'),
            };
          }
        }

        // Combined message: Suggestion content + Action buttons
        const blocks: any[] = [
          introBlock,
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `\`\`\`${sessionData.extractedKnowledge}\`\`\``,
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
                text: tManager('docUpdate.extract.card.editSuggestion.button'),
                emoji: true,
              },
              action_id: 'open_knowledge_edit_manager_modal',
              value: sessionId,
            },
            {
              type: 'button' as const,
              text: {
                type: 'plain_text' as const,
                text: tManager('docUpdate.extract.card.startProcess.button'),
                emoji: true,
              },
              style: 'primary' as const,
              action_id: 'suggest_updates',
              value: JSON.stringify({
                sessionId: sessionId,
                originalChannelId: sessionData.originalChannelId,
                originalThreadTs: sessionData.originalThreadTs,
                continueToFileSelection: true,
              }),
            },
            {
              type: 'button' as const,
              text: {
                type: 'plain_text' as const,
                text: tManager('docUpdate.extract.card.decline.button'),
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
          text: tManager('docUpdate.extract.card.new.fallback', { userName }),
          blocks: blocks,
          unfurl_links: false,
          unfurl_media: false,
        });

        // Store manager message info for later updates
        sessionData.managerMessageInfo[managerId] = {
          channel: managerId,
          ts: postedMessage.ts, // Combined message
        };

        // 매니저 제안 세션은 14일 동안 유효하도록 설정
        const MANAGER_SESSION_EXPIRY = 14 * 24 * 60 * 60 * 1000; // 14일
        storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE, MANAGER_SESSION_EXPIRY);

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
            extractedKnowledge: sessionData.extractedKnowledge,
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
      // Posted back into the channel the request came from, so it follows the
      // workspace default rather than the requester's own language — including
      // the channel-name fallback, which is a word inside that sentence.
      const tChannel = await tForWorkspace(workspaceId);
      const originalChannelName = await getChannelName(sessionData.originalChannelId, client, tChannel);

      // 매니저 이름 목록을 볼드체로 변환
      const managerNames = await Promise.all(managers.map((id: string) => getUserName(id, client)));
      const managerNamesBold = managerNames.map((name: string) => `*${name}*`).join(', ');

      await client.chat.postMessage({
        channel: sessionData.originalChannelId,
        text: tChannel('docUpdate.extract.sent.channel.fallback', {
          count: managers.length,
          userName,
          managerNames: managerNamesBold,
          channelName: originalChannelName,
        }),
        thread_ts: sessionData.originalThreadTs,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: tChannel('docUpdate.extract.sent.channel', {
                count: managers.length,
                userName,
                managerNames: managerNamesBold,
              }),
            },
          },
        ],
        unfurl_links: false,
        unfurl_media: false,
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: t('docUpdate.extract.sent.dm', { count: managers.length }),
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
      text: t('docUpdate.extract.error.sendFailed'),
    });
  }
};
