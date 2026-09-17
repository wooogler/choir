import type { T } from '../../../src/i18n';

export const HANDLE_AS_QUESTION_ACTION_ID = 'handle_as_question';
export const HANDLE_AS_UPDATE_REQUEST_ACTION_ID = 'handle_as_update_request';

/**
 * The private "if I misunderstood you, say so" prompt posted under a general
 * answer, with its two reclassification buttons.
 *
 * It is a builder rather than a literal inside the handler so the blocks can be
 * rendered in a test without standing up a Slack client: these are the only
 * conversation strings Block Kit length-caps, and a Korean button label that
 * overflows is invisible until Slack rejects the post.
 *
 * `t` is the *asker's* translator — they are the only person who sees this.
 */
export function buildClarifyPromptBlocks(params: { t: T; sessionId: string; blockId: string }): any[] {
  const { t, sessionId, blockId } = params;
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('conversation.clarifyPrompt.body'),
      },
      block_id: blockId,
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('conversation.clarifyPrompt.question.button'),
            emoji: true,
          },
          action_id: HANDLE_AS_QUESTION_ACTION_ID,
          value: sessionId,
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('conversation.clarifyPrompt.updateRequest.button'),
            emoji: true,
          },
          action_id: HANDLE_AS_UPDATE_REQUEST_ACTION_ID,
          value: sessionId,
        },
      ],
    },
  ];
}
