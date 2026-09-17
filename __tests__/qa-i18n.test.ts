// The Q&A and DM surfaces after the catalog migration. Three things are worth
// testing and nothing else is: that English did not move a byte (the modal a
// user sees today must be the modal they see tomorrow), that Korean actually
// fits Slack's modal chrome, and that each message is written in the language
// of whoever ends up reading it — the workspace for a channel post, the
// recipient for a DM, the clicker for a modal.

const getSessionData = jest.fn();
const tForWorkspace = jest.fn();
const tForUser = jest.fn();

/** The workspace's language, and any per-user overrides, for one test. */
let workspaceLocale: 'en' | 'ko' = 'en';
let userLocales: Record<string, 'en' | 'ko'> = {};

jest.mock('services/common', () => ({
  SessionType: { DOCUMENT_UPDATE: 'document_update' },
  getSessionData: (...args: unknown[]) => getSessionData(...args),
}));

jest.mock('services/common/interaction-tracker', () => ({
  logButtonClick: jest.fn(async () => undefined),
  logModalSubmit: jest.fn(),
}));

// The resolvers are stubbed so a locale is a fixture rather than a database
// read; `createT` itself is the real one, because the rendered strings are the
// point of these tests.
jest.mock('services/i18n', () => {
  const { createT, isSupportedLocale } = jest.requireActual('../src/i18n');
  return {
    tForRequest: (context: any) => createT(isSupportedLocale(context?.locale) ? context.locale : 'en'),
    tForWorkspace: (...args: unknown[]) => {
      tForWorkspace(...args);
      return Promise.resolve(createT(workspaceLocale));
    },
    tForUser: (...args: unknown[]) => {
      tForUser(...args);
      return Promise.resolve(createT(userLocales[args[1] as string] ?? workspaceLocale));
    },
  };
});

// The barrel is replaced wholesale: the two modal handlers only need four
// functions out of it, and loading the real one drags in the database.
jest.mock('services/slack', () => ({
  createQAChannelPreview: jest.fn(async () => '<<PREVIEW>>'),
  createPrivateMessagePreview: jest.fn(async () => '<<PREVIEW>>'),
  getQAChannel: jest.fn(async () => 'CQNA'),
  getManagers: jest.fn(async () => ['UMANAGER']),
  getUserName: jest.fn(async () => 'Dana'),
  getWorkspaceId: jest.fn(async () => 'T1'),
}));

// `services/slack/qa-channel` is loaded for real (it is what builds the shared
// Q&A), so its two module-level dependencies are stubbed instead.
jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('services/slack/user-management', () => ({
  getWorkspaceId: jest.fn(async () => 'T1'),
}));

import { askToChannelModalCallback } from '../listeners/features/qa/ask-to-channel-modal-action';
import { askToOthersModalCallback } from '../listeners/features/qa/ask-to-others-modal-action';
import { createPrivateMessage, createQAChannelMessage } from '../services/slack/qa-channel';
import { SLACK_LIMITS } from '../src/i18n';

/**
 * The ask-to-others view exactly as it rendered before the migration, captured
 * by running the handler against the pre-migration source. The preview text is
 * a stub because it comes from a separate builder with its own tests; every
 * other byte here is the chrome this migration was not allowed to touch.
 */
const PRE_MIGRATION_ASK_TO_OTHERS_VIEW = {
  type: 'modal',
  callback_id: 'ask_to_others_submit',
  notify_on_close: true,
  private_metadata: 'S1',
  title: { type: 'plain_text', text: '🔒 Ask in Private', emoji: true },
  submit: { type: 'plain_text', text: 'Send Privately', emoji: true },
  close: { type: 'plain_text', text: 'Cancel', emoji: true },
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "🔒 *Who would you like to ask privately?*\n_They'll receive this Q&A as a direct message for private discussion. You can also add your own thoughts or context._",
      },
    },
    {
      type: 'input',
      block_id: 'user_comment',
      element: {
        type: 'plain_text_input',
        action_id: 'comment_text',
        multiline: true,
        placeholder: {
          type: 'plain_text',
          text: 'Add your thoughts or context about this question and answer (optional)',
        },
      },
      label: { type: 'plain_text', text: '💭 Your Comment', emoji: true },
      optional: true,
    },
    {
      type: 'input',
      block_id: 'users_select',
      element: {
        type: 'multi_users_select',
        action_id: 'users',
        placeholder: { type: 'plain_text', text: 'Choose people to share with...' },
        initial_users: ['UMANAGER'],
      },
      label: { type: 'plain_text', text: '👤 People', emoji: true },
    },
    {
      type: 'input',
      block_id: 'anonymous_select',
      element: {
        type: 'checkboxes',
        action_id: 'anonymous_checkbox_private',
        options: [
          {
            text: {
              type: 'plain_text',
              text: "Share anonymously (show as 'A team member' and exclude me from the DM)",
            },
            value: 'anonymous',
          },
        ],
      },
      label: { type: 'plain_text', text: '🎭 Privacy Options', emoji: true },
      optional: true,
    },
    { type: 'divider' },
    {
      type: 'section',
      block_id: 'preview_section',
      text: { type: 'mrkdwn', text: "👀 *Here's what will be shared:*" },
    },
    { type: 'section', block_id: 'preview_content', text: { type: 'mrkdwn', text: '<<PREVIEW>>' } },
  ],
};

/** Runs a modal-opening action handler and returns the view it opened. */
async function openModal(callback: (args: any) => Promise<void>, locale: 'en' | 'ko'): Promise<Record<string, any>> {
  const open = jest.fn(async () => ({ ok: true }));
  await callback({
    ack: async () => {},
    body: {
      actions: [{ value: 'S1' }],
      user: { id: 'U1' },
      channel: { id: 'C1' },
      trigger_id: 'TRIG',
    },
    client: {
      views: { open },
      conversations: {
        info: jest.fn(async () => ({ channel: { name: 'qna', is_private: false, is_im: false } })),
      },
      chat: { postEphemeral: jest.fn(async () => ({})) },
    },
    context: { locale },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  expect(open).toHaveBeenCalledTimes(1);
  return (open.mock.calls[0] as any[])[0].view;
}

beforeEach(() => {
  jest.clearAllMocks();
  workspaceLocale = 'en';
  userLocales = {};
  getSessionData.mockReturnValue({ originalQuestion: 'Q?', botResponse: 'A.' });
});

describe('the share modals', () => {
  it('renders the ask-to-others view byte-for-byte as it did before the migration', async () => {
    expect(await openModal(askToOthersModalCallback, 'en')).toEqual(PRE_MIGRATION_ASK_TO_OTHERS_VIEW);
  });

  it('keeps every action_id, block_id and callback_id when the locale changes', async () => {
    const english = await openModal(askToOthersModalCallback, 'en');
    const korean = await openModal(askToOthersModalCallback, 'ko');

    const identifiers = (view: any) =>
      JSON.stringify([
        view.callback_id,
        view.private_metadata,
        view.blocks.map((block: any) => [block.block_id, block.element?.action_id, block.element?.type]),
      ]);
    expect(identifiers(korean)).toEqual(identifiers(english));
  });

  it('speaks Korean to a Korean clicker', async () => {
    const channel = await openModal(askToChannelModalCallback, 'ko');
    const others = await openModal(askToOthersModalCallback, 'ko');

    expect(channel.title.text).toBe('📢 Q&A 채널에 공유');
    expect(channel.submit.text).toBe('채널에 올리기');
    expect(channel.close.text).toBe('취소');
    expect(channel.blocks[0].text.text).toContain('#qna 채널에 공유할까요?');
    expect(channel.blocks[1].label.text).toBe('💭 내 코멘트');

    expect(others.title.text).toBe('🔒 비공개로 질문하기');
    expect(others.submit.text).toBe('비공개로 보내기');
    expect(others.blocks[2].label.text).toBe('👤 받는 사람');
    expect(others.blocks[3].element.options[0].text.text).toContain('익명으로 공유해요');
  });

  it('keeps Korean modal chrome inside Slack’s limits', async () => {
    for (const callback of [askToChannelModalCallback, askToOthersModalCallback]) {
      const view = await openModal(callback, 'ko');
      // Compared as objects so a failure names the string that overflowed.
      expect({ text: view.title.text, withinLimit: view.title.text.length <= SLACK_LIMITS.title }).toEqual({
        text: view.title.text,
        withinLimit: true,
      });
      for (const footer of [view.submit, view.close]) {
        expect({ text: footer.text, withinLimit: footer.text.length <= SLACK_LIMITS.button }).toEqual({
          text: footer.text,
          withinLimit: true,
        });
      }
    }
  });
});

describe('who a shared Q&A is written for', () => {
  it('writes the channel post in the workspace’s language', async () => {
    workspaceLocale = 'ko';
    // A recipient override that must NOT win: nobody in particular reads a
    // channel post.
    userLocales = { U1: 'en' };

    const blocks = await createQAChannelMessage('qna', 'U1', 'Q?', 'A.', true, false, 'Dana', 'FYI', undefined, 'T1');

    expect(tForWorkspace).toHaveBeenCalledWith('T1');
    expect(tForUser).not.toHaveBeenCalled();
    expect(blocks[0].text.text).toContain('#qna 여러분, 안녕하세요.');
    expect(blocks[1].text.text).toBe('*제 답변:*\nA.');
    expect(blocks.at(-1).text.text).toBe('*Dana님이 덧붙였어요:*\nFYI');
  });

  it('writes the DM in the recipient’s language, not the workspace’s', async () => {
    workspaceLocale = 'en';
    userLocales = { U9: 'ko' };
    const client = {} as any;

    const blocks = await createPrivateMessage('D1', 'U1', 'Q?', 'A.', true, false, 'Dana', undefined, undefined, {
      workspaceId: 'T1',
      userId: 'U9',
      client,
    });

    expect(tForUser).toHaveBeenCalledWith('T1', 'U9', client);
    expect(tForWorkspace).not.toHaveBeenCalled();
    expect(blocks[0].text.text).toBe('안녕하세요!\nDana님이 저에게 아래 질문을 하고, 제 답변을 회원님께 공유했어요.');
    expect(blocks[1].text.text).toBe('*질문:*\nQ?');
    expect(blocks[3].text.text).toContain('도와주실 수 있을까요?');
  });

  it('falls back to English rather than dropping a message when no audience is known', async () => {
    workspaceLocale = 'ko';

    const blocks = await createPrivateMessage('D1', 'U1', 'Q?', 'A.', false, true, undefined, 'S1');

    expect(tForUser).not.toHaveBeenCalled();
    expect(blocks[0].text.text).toBe(
      'Hi there!\nA team member asked me the following question and shared my response with you.',
    );
    expect(blocks.at(-1).text.text).toContain('Want to reply to the questioner?');
  });
});
