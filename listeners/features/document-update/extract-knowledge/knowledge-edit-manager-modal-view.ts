import type { AllMiddlewareArgs, SlackViewAction, SlackViewMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { logModalSubmit } from 'services/common/user-interaction-logger';
import { getManagers, getUserName, getWorkspaceId } from 'services/slack';
import { withRateLimit } from 'services/slack/rate-limit-handler';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
// import suggestUpdatesCallback from "../document-handlers/suggest-updates"; // Not used here
// import { SlackMessage } from "services/slack"; // Not used here

/**
 * Handle knowledge edit modal submission by a manager
 */
export async function handleKnowledgeEditManagerModal({
  ack,
  body,
  view,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<SlackViewAction>) {
  const startTime = Date.now();
  let workspaceId: string | undefined;
  await ack();
  const userId = body.user.id; // Manager's ID

  try {
    workspaceId = await getWorkspaceId(client);
    const sessionId = view.private_metadata;

    if (!sessionId) {
      throw new Error('No session ID found in modal metadata for manager edit');
    }

    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      await client.chat.postMessage({
        channel: userId,
        text: '❌ Session data not found. Please try again or ask the user to resubmit.',
      });

      // 로그: 세션 데이터 없음
      logModalSubmit(
        userId,
        workspaceId || 'unknown',
        'knowledge_edit_manager_modal',
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

    const editedKnowledge = view.state.values.knowledge_input?.knowledge_text?.value;
    const originalKnowledge = sessionData.extractedKnowledge || ''; // Capture original before updating

    if (!editedKnowledge || editedKnowledge.trim() === '') {
      logger.warn('Manager tried to submit empty knowledge.');
      // No need to post message here as modal will show an error,
      // or we can choose to update the view with an error.
      // For now, just return, Slack might show a default error or nothing.

      // 로그: 빈 지식 내용
      logModalSubmit(
        userId,
        workspaceId || 'unknown',
        'knowledge_edit_manager_modal',
        Date.now() - startTime,
        false,
        {
          error: 'Empty knowledge content',
          sessionId,
          originalKnowledge,
        },
        client,
        'modal',
        'dm',
      );
      return;
    }

    // Update session data with edited knowledge and who edited it
    sessionData.extractedKnowledge = editedKnowledge.trim();
    sessionData.lastEditedBy = userId; // Mark manager as last editor
    sessionData.lastEditedAt = new Date().toISOString();
    storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE);

    logger.info(`Knowledge for session ${sessionId} edited by manager ${userId}`);

    const managerMessageInfo = sessionData.managerMessageInfo?.[userId];

    if (managerMessageInfo && managerMessageInfo.ts && managerMessageInfo.channel) {
      const blocks: any[] = [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '📝 Document Update Suggestion', // Title remains same or can indicate edit
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*From:* <@${sessionData.userId}> (Original requester: ${sessionData.userName || 'Unknown User'})\n*Content:*\n\`\`\`${editedKnowledge.trim()}\`\`\``,
          },
        },
      ];

      if (sessionData.originalMessageLink) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📍 <${sessionData.originalMessageLink}|View original discussion> for context`,
          },
        });
      }

      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Edit Knowledge',
              emoji: true,
            },
            action_id: 'open_knowledge_edit_manager_modal',
            value: sessionId,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Start Document Update',
              emoji: true,
            },
            style: 'primary',
            action_id: 'suggest_updates',
            value: JSON.stringify({
              sessionId: sessionId,
              originalChannelId: sessionData.originalChannelId,
              originalThreadTs: sessionData.originalThreadTs,
            }),
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Dismiss',
              emoji: true,
            },
            style: 'danger',
            action_id: 'cancel_knowledge_extraction',
            value: sessionId,
          },
        ],
      });

      try {
        // Step 1: Delete the old message with rate limit handling
        await withRateLimit(
          () =>
            client.chat.delete({
              channel: managerMessageInfo.channel,
              ts: managerMessageInfo.ts,
            }),
          'delete old message',
          2, // Max 2 retries for delete operation
        ).catch((deleteError) => {
          logger.warn(`Failed to delete old message, proceeding with recreation:`, deleteError);
        });

        // Step 2: Create new message with updated content (complete message with greeting and buttons)
        const choirGreeting = `Hi! I'm CHOIR, your documentation assistant.\n \n \n*${sessionData.userName || 'Unknown User'}* has a document update suggestion:`;

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
                alt_text: sessionData.userName || 'User profile',
              };
            } else {
              // Fallback to default profile image
              introBlock.accessory = {
                type: 'image',
                image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
                alt_text: sessionData.userName || 'User profile',
              };
            }
          } catch (error) {
            console.error('Error fetching user profile image:', error);
            // Fallback to default profile image on error
            introBlock.accessory = {
              type: 'image',
              image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
              alt_text: sessionData.userName || 'User profile',
            };
          }
        }

        const completeBlocks: any[] = [
          introBlock,
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '📝 Document Update Suggestion (Edited by Manager)',
              emoji: true,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*From:* *${sessionData.userName || 'Unknown User'}*`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `\`\`\`${editedKnowledge.trim()}\`\`\``,
            },
          },
        ];

        if (sessionData.originalMessageLink) {
          completeBlocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📍 <${sessionData.originalMessageLink}|View original discussion> for context`,
            },
          });
        }

        completeBlocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '✏️ Edit Suggestion',
                emoji: true,
              },
              action_id: 'open_knowledge_edit_manager_modal',
              value: sessionId,
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '🚀 Start Update Process',
                emoji: true,
              },
              style: 'primary',
              action_id: 'suggest_updates',
              value: JSON.stringify({
                sessionId: sessionId,
                originalChannelId: sessionData.originalChannelId,
                originalThreadTs: sessionData.originalThreadTs,
              }),
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Dismiss',
                emoji: true,
              },
              style: 'danger',
              action_id: 'cancel_knowledge_extraction',
              value: sessionId,
            },
          ],
        });

        const newMessage = await withRateLimit(
          () =>
            client.chat.postMessage({
              channel: managerMessageInfo.channel,
              text: `📝 Document update suggestion updated by manager for session ${sessionId}.`,
              blocks: completeBlocks,
              unfurl_links: false,
              unfurl_media: false,
            }),
          'post updated message',
        );

        // Step 3: Update session data with new timestamp
        if (newMessage?.ts) {
          sessionData.managerMessageInfo[userId].ts = newMessage.ts;
          storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE);
        }
      } catch (updateError) {
        logger.warn(
          `Failed to update original message for manager ${userId} in session ${sessionId}: ${updateError instanceof Error ? updateError.message : 'Unknown error'}. Using fallback approach.`,
        );
        // Use the fallback logic that's already implemented below
        // Fall through to the else block by setting managerMessageInfo to null
      }
    }

    if (!managerMessageInfo || !managerMessageInfo.ts || !managerMessageInfo.channel) {
      logger.warn(
        `Original message info not found for manager ${userId} in session ${sessionId}. Cannot update the message. Posting a new one as fallback.`,
      );
      // Fallback: If somehow the original message info is lost, post a new message to the manager.
      // This new message will also have the "Edit Knowledge" button.
      const fallbackBlocks: any[] = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Knowledge Updated (Original Message Not Found):*\n\`\`\`${editedKnowledge.trim()}\`\`\``,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Edit Knowledge',
                emoji: true,
              },
              action_id: 'open_knowledge_edit_manager_modal',
              value: sessionId,
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Start Document Update',
                emoji: true,
              },
              style: 'primary',
              action_id: 'suggest_updates',
              value: JSON.stringify({
                sessionId: sessionId,
                originalChannelId: sessionData.originalChannelId,
                originalThreadTs: sessionData.originalThreadTs,
              }),
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Dismiss',
                emoji: true,
              },
              style: 'danger',
              action_id: 'cancel_knowledge_extraction',
              value: sessionId,
            },
          ],
        },
      ];
      if (sessionData.originalMessageLink) {
        fallbackBlocks.unshift({
          // Add link at the beginning if available
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📍 <${sessionData.originalMessageLink}|View original discussion> for context`,
          },
        });
      }
      fallbackBlocks.unshift({
        type: 'header',
        text: {
          type: 'plain_text',
          text: '📝 Document Update Suggestion',
          emoji: true,
        },
      });
      fallbackBlocks.splice(1, 0, {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*From:* <@${sessionData.userId}> (Original requester: ${sessionData.userName || 'Unknown User'})`,
        },
      });

      await withRateLimit(
        () =>
          client.chat.postMessage({
            channel: userId,
            text: 'Knowledge updated. You can now start the document update process.',
            blocks: fallbackBlocks,
            unfurl_links: false,
            unfurl_media: false,
          }),
        'send fallback message',
      );
    }

    // Update the original preview message in the channel/thread (similar to regular edit modal)
    try {
      // Get managers for the message
      const managers = await getManagers(workspaceId);
      let managerText = 'managers';
      if (managers.length > 0) {
        // Get first manager's name as example
        const firstManagerName = await getUserName(managers[0], client);
        managerText = managers.length === 1 ? firstManagerName : `${firstManagerName} and other managers`;
      }

      // Find the original public message to update
      if (sessionData.publicMessageTs) {
        await withRateLimit(
          () =>
            client.chat.update({
              channel: sessionData.originalChannelId,
              ts: sessionData.publicMessageTs,
              text: `Sure! I'll suggest the following update to ${managerText}. (Edited by Manager)`,
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `Sure! I'll suggest the following update to ${managerText}. *(Edited by Manager)*`,
                  },
                  block_id: createCHOIRBlockId(CHOIRMessageType.DOCUMENT_SUGGESTION),
                },
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `*Suggested Update*\n\`\`\`${editedKnowledge.trim()}\`\`\``,
                  },
                },
              ],
            }),
          'update public message',
        );
        logger.info(`Public message updated for session ${sessionId} by manager ${userId}`);
      } else {
        logger.warn(`No publicMessageTs found for session ${sessionId}, cannot update public message`);
      }
    } catch (updateError) {
      logger.warn('Failed to update original public message:', updateError);
      // Continue without failing if public message update fails
    }

    // 로그: 성공
    // originalChannelId에서 채널 정보 추출
    const actualChannelId = sessionData.originalChannelId || 'modal';
    let actualChannelType: 'public' | 'private' | 'dm' = 'dm';
    try {
      if (sessionData.originalChannelId) {
        const channelInfo = await withRateLimit(
          () => client.conversations.info({ channel: sessionData.originalChannelId }),
          'get channel info for logging',
        );
        if (channelInfo?.channel?.is_private) {
          actualChannelType = 'private';
        } else if (channelInfo?.channel?.is_im) {
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
      workspaceId || 'unknown',
      'knowledge_edit_manager_modal',
      Date.now() - startTime,
      true,
      {
        sessionId,
        originalUserId: sessionData.userId,
        originalChannelId: sessionData.originalChannelId,
        originalThreadTs: sessionData.originalThreadTs,
        originalKnowledge: originalKnowledge,
        editedKnowledge: editedKnowledge.trim(),
        originalKnowledgeLength: originalKnowledge.length,
        editedKnowledgeLength: editedKnowledge.trim().length,
        messageUpdated: !!(managerMessageInfo && managerMessageInfo.ts && managerMessageInfo.channel),
        fallbackMessageSent: !(managerMessageInfo && managerMessageInfo.ts && managerMessageInfo.channel),
      },
      client,
      actualChannelId,
      actualChannelType,
    );
  } catch (error) {
    logger.error('Error processing manager knowledge edit modal:', error);
    await withRateLimit(
      () =>
        client.chat.postMessage({
          channel: userId, // Use manager's ID for error message
          text: `❌ Error processing knowledge edit: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }),
      'send error message',
    ).catch((errorMessageError) => {
      logger.error('Failed to send error message due to rate limiting:', errorMessageError);
    });

    // 로그: 실패
    if (!workspaceId) {
      try {
        workspaceId = await getWorkspaceId(client);
      } catch (workspaceError) {
        logger.warn('Failed to get workspace ID for logging:', workspaceError);
      }
    }

    logModalSubmit(
      userId,
      workspaceId || 'unknown',
      'knowledge_edit_manager_modal',
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
  }
}
