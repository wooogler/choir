// The conversation and registration surfaces after the catalog migration.
//
// Two different bugs are in scope. The first is a silent regression: these are
// blocks a user sees on their very first contact with CHOIR, so the English
// they render must be byte-for-byte what the hard-coded literals produced —
// the `PRE_MIGRATION` fixtures below were captured from the working tree before
// a single string moved into the catalog. The second is a send site that
// reaches for the *actor's* language when the reader is somebody else: a
// manager approves or declines, but the DM that follows is read by the person
// who asked for access, and it must be in their language, not the manager's.

import { createT } from '../src/i18n';
import { SLACK_LIMITS } from '../src/i18n/limits';

const tForRequest = jest.fn();
const tForUser = jest.fn();
const tForWorkspace = jest.fn();

jest.mock('services/i18n', () => ({
  tForRequest: (...args: unknown[]) => tForRequest(...args),
  tForUser: (...args: unknown[]) => tForUser(...args),
  tForWorkspace: (...args: unknown[]) => tForWorkspace(...args),
}));

const registrationRequest = jest.fn();
const clearRegistrationRequest = jest.fn();
const saveRegistrationRequest = jest.fn();
const approveCHOIRUser = jest.fn();
const isCHOIRUser = jest.fn();

jest.mock('services/slack', () => ({
  getWorkspaceId: jest.fn(async () => 'T1'),
  getUserName: jest.fn(async (id: string) => id),
  getRegistrationRequest: (...args: unknown[]) => registrationRequest(...args),
  clearRegistrationRequest: (...args: unknown[]) => clearRegistrationRequest(...args),
  saveRegistrationRequest: (...args: unknown[]) => saveRegistrationRequest(...args),
  approveCHOIRUser: (...args: unknown[]) => approveCHOIRUser(...args),
  isCHOIRUser: (...args: unknown[]) => isCHOIRUser(...args),
}));

jest.mock('services/common/interaction-tracker', () => ({
  logButtonClick: jest.fn(async () => undefined),
}));

jest.mock('../listeners/features/app-home/management/shared', () => ({
  requireManagerForAction: jest.fn(async () => true),
}));

jest.mock('../listeners/features/qa/question-handler', () => ({
  handleQuestionMessage: jest.fn(async () => true),
}));

import { buildClarifyPromptBlocks } from '../listeners/features/conversation/shared';
import { approveChoirRegistrationAction } from '../listeners/features/registration/approve-registration-action';
import { declineChoirRegistrationAction } from '../listeners/features/registration/decline-registration-action';
import { buildNonUserResponse } from '../services/slack/user-management';

/** Captured from the pre-migration working tree; see the file header. */
const PRE_MIGRATION = {
  prompt: {
    text: '💡 If I misunderstood your message, please click one of the buttons below:',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '💡 *If I misunderstood your message, please click one of the buttons below:*',
        },
        block_id: 'BLOCKID',
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '❓ This was a question', emoji: true },
            action_id: 'handle_as_question',
            value: 'SESSION',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '📝 This was an update request', emoji: true },
            action_id: 'handle_as_update_request',
            value: 'SESSION',
          },
        ],
      },
    ],
  },
  fresh: {
    text: "Hi! 👋 I'm CHOIR, your team's documentation assistant. You're not a CHOIR user yet — tap the button below and a workspace manager can approve you with one click.",
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "Hi! 👋 I'm CHOIR, your team's documentation assistant. You're not a CHOIR user yet — tap the button below and a workspace manager can approve you with one click.",
        },
        block_id: 'BID',
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: "If approved, I'll answer the question you just asked right away. Until then it stays private — I don't process or store it.",
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Your manager may ask you to complete the consent form: <https://example.com/consent|here>.',
          },
        ],
      },
    ],
  },
  pending: {
    text: "⏳ Your access request is waiting for manager approval. I'll message you as soon as you're in!",
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "⏳ Your access request is waiting for manager approval. I'll message you as soon as you're in!",
        },
        block_id: 'BID',
      },
    ],
  },
  declined: {
    text: "Your earlier access request wasn't approved. If you think this is a mistake, please reach out to a workspace manager directly.",
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "Your earlier access request wasn't approved. If you think this is a mistake, please reach out to a workspace manager directly.",
        },
        block_id: 'BID',
      },
    ],
  },
};

const en = createT('en');
const ko = createT('ko');

/** Every `plain_text` button label anywhere in a block set. */
function buttonLabels(blocks: any[]): string[] {
  return blocks.flatMap((block) =>
    (block.elements ?? []).filter((el: any) => el.type === 'button').map((el: any) => el.text.text as string),
  );
}

/** Has at least one Hangul syllable and no untranslated ASCII sentence. */
const isKorean = (text: string) => /[가-힣]/.test(text);

describe('the "I may have misunderstood you" prompt', () => {
  it('renders English exactly as the pre-migration literals did', () => {
    expect(buildClarifyPromptBlocks({ t: en, sessionId: 'SESSION', blockId: 'BLOCKID' })).toEqual(
      PRE_MIGRATION.prompt.blocks,
    );
    expect(en('conversation.clarifyPrompt.fallback')).toBe(PRE_MIGRATION.prompt.text);
  });

  it('renders Korean for a Korean asker, buttons included', () => {
    const blocks = buildClarifyPromptBlocks({ t: ko, sessionId: 'SESSION', blockId: 'BLOCKID' });

    expect(isKorean(blocks[0].text.text)).toBe(true);
    const labels = buttonLabels(blocks);
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect([label, isKorean(label)]).toEqual([label, true]);
      expect([label, label.length <= SLACK_LIMITS.button]).toEqual([label, true]);
    }
  });

  it('keeps the action_ids Slack is already routing on', () => {
    const blocks = buildClarifyPromptBlocks({ t: ko, sessionId: 'SESSION', blockId: 'BLOCKID' });
    expect(blocks[1].elements.map((el: any) => el.action_id)).toEqual([
      'handle_as_question',
      'handle_as_update_request',
    ]);
    expect(blocks[1].elements.map((el: any) => el.value)).toEqual(['SESSION', 'SESSION']);
  });
});

describe('the non-CHOIR-user access card', () => {
  const CONSENT = 'https://example.com/consent';

  it('renders English exactly as the pre-migration literals did', async () => {
    expect(
      await buildNonUserResponse('fresh', { authorizationBlockId: 'BID', consentFormUrl: CONSENT, t: en }),
    ).toEqual(PRE_MIGRATION.fresh);
    expect(await buildNonUserResponse('pending', { authorizationBlockId: 'BID', t: en })).toEqual(
      PRE_MIGRATION.pending,
    );
    expect(await buildNonUserResponse('declined', { authorizationBlockId: 'BID', t: en })).toEqual(
      PRE_MIGRATION.declined,
    );
  });

  it('defaults to English when no translator is passed', async () => {
    expect(await buildNonUserResponse('fresh', { authorizationBlockId: 'BID', consentFormUrl: CONSENT })).toEqual(
      PRE_MIGRATION.fresh,
    );
  });

  it('renders Korean for a Korean stranger, and keeps the URL out of the catalog', async () => {
    const { text, blocks } = await buildNonUserResponse('fresh', {
      authorizationBlockId: 'BID',
      consentFormUrl: CONSENT,
      t: ko,
    });

    expect(isKorean(text)).toBe(true);
    expect(blocks[0].block_id).toBe('BID'); // history exclusion unchanged
    for (const block of blocks) {
      const rendered = block.text?.text ?? block.elements[0].text;
      expect([rendered, isKorean(rendered)]).toEqual([rendered, true]);
    }
    // The consent link is assembled at the call site; only its label is translated.
    expect(blocks[2].elements[0].text).toContain(`<${CONSENT}|${ko('registration.link.consentFormHere')}>`);
  });

  it('keeps the Request Access button within Slack’s label cap in every locale', () => {
    for (const t of [en, ko]) {
      const label = t('registration.nonUser.request.button');
      expect([t.locale, label.length <= SLACK_LIMITS.button]).toEqual([t.locale, true]);
    }
  });
});

describe('approve / decline speak the requester’s language, not the manager’s', () => {
  const MANAGER = 'M-en';
  const REQUESTER = 'U-ko';
  const LOCALE_BY_USER: Record<string, 'en' | 'ko'> = { [MANAGER]: 'en', [REQUESTER]: 'ko' };

  const silentLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

  function makeClient() {
    return {
      chat: { postMessage: jest.fn(async () => ({ ok: true, ts: '1.1', channel: 'D-target' })), update: jest.fn() },
      conversations: { open: jest.fn(async () => ({ channel: { id: 'D-target' } })) },
    } as any;
  }

  const body = {
    user: { id: MANAGER },
    actions: [{ value: REQUESTER }],
    response_url: 'https://hooks.slack.test/replace',
    channel: { id: 'D-manager' },
  } as any;

  const pendingRequest = () => ({
    workspaceId: 'T1',
    userId: REQUESTER,
    userName: 'New Bie',
    status: 'pending',
    heldQuestion: 'How do I request travel funding?',
    origin: { channelId: 'C-public', isPublic: true },
    managerMessageInfo: {},
    createdAt: 1,
    updatedAt: 1,
  });

  /** Whatever was pushed through response_url (the acting manager's own view). */
  const replacedOriginal = () => JSON.parse(((global as any).fetch as jest.Mock).mock.calls[0][1].body);

  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).fetch = jest.fn(async () => ({ ok: true }));
    tForRequest.mockImplementation(() => createT('en')); // the manager clicked
    tForUser.mockImplementation(async (_workspaceId: string, userId: string) =>
      createT(LOCALE_BY_USER[userId] ?? 'en'),
    );
    tForWorkspace.mockImplementation(async () => createT('en'));
    registrationRequest.mockReturnValue(pendingRequest());
    clearRegistrationRequest.mockReturnValue(true);
    isCHOIRUser.mockResolvedValue(false);
  });

  it('approve: welcomes the requester in Korean while confirming to the manager in English', async () => {
    const client = makeClient();
    await approveChoirRegistrationAction({ ack: jest.fn(), body, client, context: {}, logger: silentLogger() } as any);

    // The requester's translator was resolved for the requester, with a client
    // so a brand-new user's Slack locale can still be fetched.
    expect(tForUser).toHaveBeenCalledWith('T1', REQUESTER, client);

    const dm = client.chat.postMessage.mock.calls.map(([arg]: any[]) => arg.text);
    expect(dm[0]).toBe(ko('registration.approve.welcome.withQuestion'));
    expect(dm[1]).toBe(ko('registration.approve.originChannelHint', { channelLink: '<#C-public>' }));

    expect(replacedOriginal().text).toBe(en('registration.approve.confirmation', { targetName: 'New Bie' }));
  });

  it('decline: notifies the requester in Korean while confirming to the manager in English', async () => {
    const client = makeClient();
    await declineChoirRegistrationAction({ ack: jest.fn(), body, client, context: {}, logger: silentLogger() } as any);

    expect(tForUser).toHaveBeenCalledWith('T1', REQUESTER, client);
    expect(client.chat.postMessage.mock.calls[0][0].text).toBe(ko('registration.decline.notice'));
    expect(replacedOriginal().text).toBe(en('registration.decline.confirmation', { targetName: 'New Bie' }));
  });

  it('decline: an already-handled request tells the clicking manager, in their language', async () => {
    registrationRequest.mockReturnValue({ ...pendingRequest(), status: 'declined' });
    const client = makeClient();
    await declineChoirRegistrationAction({ ack: jest.fn(), body, client, context: {}, logger: silentLogger() } as any);

    expect(replacedOriginal().text).toBe(en('registration.action.alreadyHandled'));
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});
