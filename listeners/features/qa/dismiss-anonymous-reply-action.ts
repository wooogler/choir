import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/interaction-tracker';
import { tForRequest } from 'services/i18n';
import { getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

/**
 * Anonymous reply에서 "No Thanks" 버튼 처리
 */
export const dismissAnonymousReplyCallback = async ({
  ack,
  body,
  client,
  context,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  // `replace_original` rewrites the clicker's own ephemeral, so this is their
  // language.
  const t = tForRequest(context);

  try {
    const sessionId = body.actions[0].value;

    // response_url을 통해 ephemeral 메시지를 "완료됨" 상태로 업데이트
    if (body.response_url) {
      await fetch(body.response_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          replace_original: true,
          text: t('qa.dismissAnonymous.text'),
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('qa.dismissAnonymous'),
              },
            },
          ],
        }),
      });
    }

    logger.info(`Anonymous reply dismissed for session ${sessionId}`);

    // 로그 기록
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      body.user.id,
      workspaceId,
      body.channel?.id || body.user.id,
      'dm',
      'dismiss_anonymous_reply',
      Date.now() - startTime,
      true,
      {
        sessionId,
      },
      client,
    );
  } catch (error) {
    logger.error('Error dismissing anonymous reply:', error);

    // 에러 로깅
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || body.user.id,
        'dm',
        'dismiss_anonymous_reply',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          sessionId: body.actions[0].value,
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log error:', logError);
    }
  }
};
