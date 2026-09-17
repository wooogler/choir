// Recipient-scoped notifications: every message here is read by someone who is
// not the person who acted, so the bug these tests exist to catch is a send site
// that reaches for the *actor's* language (or the request's) instead of the
// reader's. Each assertion therefore pins two things: the English text, byte for
// byte, so the migration changed nothing for an English workspace, and the fact
// that a Korean recipient in the same fan-out gets Korean.

import { createT } from '../src/i18n';
import { CHOIRMessageType, extractCHOIRMessageType } from '../src/types/message-types';

const tForUser = jest.fn();
const tForWorkspace = jest.fn();
const getWorkspaceId = jest.fn();
const getManagers = jest.fn();

jest.mock('services/i18n', () => ({
  tForUser: (...args: unknown[]) => tForUser(...args),
  tForWorkspace: (...args: unknown[]) => tForWorkspace(...args),
}));

jest.mock('services/slack/user-management', () => ({
  getWorkspaceId: (...args: unknown[]) => getWorkspaceId(...args),
}));

jest.mock('services/slack', () => ({
  getWorkspaceId: (...args: unknown[]) => getWorkspaceId(...args),
  getManagers: (...args: unknown[]) => getManagers(...args),
  getUserName: jest.fn(async (id: string) => id),
}));

import {
  notifyOriginalChannel,
  notifyOtherManagersAboutUpdate,
  updateOtherManagerMessages,
} from '../listeners/features/document-update/suggestions/manager-notifications';
import { buildManagerRequestBlocks } from '../listeners/features/registration/shared';
import { createRateLimitNotificationText } from '../services/slack/rate-limit-handler';
import {
  notifyDocumentAutoReloadNoDocuments,
  notifyDocumentAutoReloadProcessingFailed,
  notifyDocumentAutoReloadStarted,
  notifyDocumentAutoReloadSucceeded,
  notifyDocumentAutoReloadSystemError,
} from '../services/slack/webhook-notifications';

/** Two managers in one workspace who read CHOIR in different languages. */
const LOCALE_BY_USER: Record<string, 'en' | 'ko'> = { 'M-en': 'en', 'M-ko': 'ko' };

const REPO = 'https://github.com/acme/handbook';

const silentLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

function makeClient() {
  return {
    chat: {
      postMessage: jest.fn(async () => ({ ok: true, ts: '1.1', channel: 'D1' })),
      update: jest.fn(async () => ({ ok: true })),
    },
  } as any;
}

/** The postMessage/update payload addressed to `channel`. */
const sentTo = (fn: jest.Mock, channel: string) =>
  fn.mock.calls.map(([arg]) => arg).find((arg) => arg.channel === channel);

beforeEach(() => {
  jest.clearAllMocks();
  getWorkspaceId.mockResolvedValue('T1');
  getManagers.mockResolvedValue([]);
  tForUser.mockImplementation(async (_workspaceId: string, userId: string) => createT(LOCALE_BY_USER[userId] ?? 'en'));
  tForWorkspace.mockImplementation(async () => createT('ko'));
});

describe('webhook auto-reload notifications', () => {
  it('speaks each manager’s own language in a single fan-out', async () => {
    const client = makeClient();

    await notifyDocumentAutoReloadStarted(client, ['M-en', 'M-ko']);

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(sentTo(client.chat.postMessage, 'M-en').text).toBe('🔄 Reflecting your document changes...');
    expect(sentTo(client.chat.postMessage, 'M-ko').text).toBe('🔄 문서 변경 사항을 반영하고 있어요...');
  });

  it('resolves the locale once per recipient, with the client, since a manager may be cold', async () => {
    const client = makeClient();

    await notifyDocumentAutoReloadStarted(client, ['M-en', 'M-ko']);

    // Two recipients, two resolutions — not one per text/blockText pair.
    expect(tForUser).toHaveBeenCalledTimes(2);
    expect(tForUser).toHaveBeenCalledWith('T1', 'M-en', client);
    expect(tForUser).toHaveBeenCalledWith('T1', 'M-ko', client);
  });

  it('keeps the English wording and block id of the no-documents notice', async () => {
    const client = makeClient();

    await notifyDocumentAutoReloadNoDocuments(client, ['M-en'], REPO);

    const sent = sentTo(client.chat.postMessage, 'M-en');
    expect(sent.text).toBe('❌ Unable to reflect changes: No documents found.');
    expect(sent.blocks[0].text.text).toBe(
      `❌ Unable to reflect changes: No documents found. <${REPO}|View Repository>`,
    );
    // The id carries a timestamp, so only the type half is stable — and the type
    // is what the other handlers route on.
    expect(extractCHOIRMessageType(sent.blocks[0].block_id)).toBe(CHOIRMessageType.RESPONSE);
  });

  it('translates the link label with the rest of the sentence', async () => {
    const client = makeClient();

    await notifyDocumentAutoReloadNoDocuments(client, ['M-ko'], REPO);

    expect(sentTo(client.chat.postMessage, 'M-ko').blocks[0].text.text).toBe(
      `❌ 변경 사항을 반영할 수 없어요: 문서를 찾지 못했어요. <${REPO}|저장소 보기>`,
    );
  });

  it('counts files as a plural, so one file is no longer "1 files"', async () => {
    const client = makeClient();

    await notifyDocumentAutoReloadSucceeded(client, ['M-en'], 3, `${REPO}/commit/abc`, 'View Changes');
    expect(sentTo(client.chat.postMessage, 'M-en').text).toBe(
      '✅ Document changes reflected successfully! Updated 3 files. View Changes',
    );
    // The preview cannot render a link; the block can.
    expect(sentTo(client.chat.postMessage, 'M-en').blocks[0].text.text).toBe(
      `✅ Document changes reflected successfully! Updated 3 files. <${REPO}/commit/abc|View Changes>`,
    );

    client.chat.postMessage.mockClear();
    await notifyDocumentAutoReloadSucceeded(client, ['M-en'], 1, `${REPO}/commit/abc`, 'View Changes');
    expect(sentTo(client.chat.postMessage, 'M-en').text).toBe(
      '✅ Document changes reflected successfully! Updated 1 file. View Changes',
    );
  });

  it('keeps the English wording of both failure notices', async () => {
    const client = makeClient();

    await notifyDocumentAutoReloadProcessingFailed(client, ['M-en'], REPO);
    expect(sentTo(client.chat.postMessage, 'M-en').blocks[0].text.text).toBe(
      `❌ Unable to reflect changes: Processing failed. Try "Reload From Github" in Home or contact research team. <${REPO}|View Repository>`,
    );

    client.chat.postMessage.mockClear();
    await notifyDocumentAutoReloadSystemError(client, ['M-en'], REPO);
    const sent = sentTo(client.chat.postMessage, 'M-en');
    expect(sent.text).toBe('❌ Unable to reflect document changes: System error occurred.');
    expect(sent.blocks[0].text.text).toBe(
      `❌ Unable to reflect document changes: System error occurred. Try "Reload From Github" in Home or contact research team. <${REPO}|View Repository>`,
    );
  });

  it('still notifies the rest when one manager’s locale cannot be resolved', async () => {
    const client = makeClient();
    tForUser.mockImplementation(async (_workspaceId: string, userId: string) => {
      if (userId === 'M-ko') throw new Error('workspace store is down');
      return createT('en');
    });

    await notifyDocumentAutoReloadStarted(client, ['M-en', 'M-ko']);

    // A language is presentation: the unresolvable manager gets English, not silence.
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(sentTo(client.chat.postMessage, 'M-ko').text).toBe('🔄 Reflecting your document changes...');
  });
});

describe('manager-to-manager update notification', () => {
  it('writes each DM in its recipient’s language and leaves the shared blocks alone', async () => {
    const client = makeClient();
    getManagers.mockResolvedValue(['M-actor', 'M-en', 'M-ko']);
    const passedBlocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'header' } }, { type: 'divider' }];

    await notifyOtherManagersAboutUpdate({}, 'M-actor', 'Dana', 'the summary', passedBlocks, client, silentLogger());

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);

    const english = sentTo(client.chat.postMessage, 'M-en');
    expect(english.text).toBe('📝 Document Update by Dana');
    expect(english.blocks[0].text.text).toBe(
      '📝 *Document Update Notification*\n\nDana has updated a document that you were also reviewing.',
    );
    // The caller's own text and trailing blocks pass through untranslated.
    expect(english.blocks[1].text.text).toBe('the summary');
    expect(english.blocks[2]).toEqual({ type: 'divider' });

    expect(sentTo(client.chat.postMessage, 'M-ko').blocks[0].text.text).toBe(
      '📝 *문서 업데이트 알림*\n\nDana님이 함께 검토하던 문서를 업데이트했어요.',
    );
  });

  it('never DMs the manager who made the update', async () => {
    const client = makeClient();
    getManagers.mockResolvedValue(['M-actor']);

    await notifyOtherManagersAboutUpdate({}, 'M-actor', 'Dana', 'the summary', [], client, silentLogger());

    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('claiming a suggestion rewrites the other managers’ cards', () => {
  const sessionData = {
    userName: 'Alice',
    extractedKnowledge: 'Travel is reimbursed within 30 days.',
    originalMessageLink: 'https://slack.com/archives/C1/p1',
    managerMessageInfo: {
      'M-actor': { channel: 'D-actor', ts: '1.0' },
      'M-en': { channel: 'D-en', ts: '2.0' },
      'M-ko': { channel: 'D-ko', ts: '3.0' },
    },
  };

  it('keeps each card in the language it was first written in', async () => {
    const client = makeClient();

    await updateOtherManagerMessages(sessionData, 'M-actor', 'Dana', client, silentLogger());

    expect(client.chat.update).toHaveBeenCalledTimes(2);

    const english = sentTo(client.chat.update, 'D-en');
    expect(english.ts).toBe('2.0');
    expect(english.text).toBe('✅ Processing started by Dana');
    expect(english.blocks[0].text.text).toBe(
      "Hi! I'm CHOIR, your documentation assistant.\n*Alice* has a document update suggestion:",
    );
    expect(english.blocks[1].text.text).toBe('```Travel is reimbursed within 30 days.```');
    expect(english.blocks[2].text.text).toBe(
      '📍 <https://slack.com/archives/C1/p1|View original discussion> for context',
    );
    expect(english.blocks[3].text.text).toBe('✅ *Processing started by Dana*');

    const korean = sentTo(client.chat.update, 'D-ko');
    expect(korean.blocks[0].text.text).toBe(
      '안녕하세요, 문서 도우미 CHOIR예요.\n*Alice*님이 문서 업데이트를 제안했어요:',
    );
    expect(korean.blocks[2].text.text).toBe(
      '📍 맥락은 <https://slack.com/archives/C1/p1|원래 대화 보기>에서 확인할 수 있어요',
    );
    expect(korean.blocks[3].text.text).toBe('✅ *Dana님이 처리를 시작했어요*');
  });

  it('translates the placeholders for a missing author and empty content', async () => {
    const client = makeClient();

    await updateOtherManagerMessages(
      { managerMessageInfo: { 'M-ko': { channel: 'D-ko', ts: '3.0' } } },
      'M-actor',
      'Dana',
      client,
      silentLogger(),
    );

    const korean = sentTo(client.chat.update, 'D-ko');
    expect(korean.blocks[0].text.text).toBe(
      '안녕하세요, 문서 도우미 CHOIR예요.\n*팀원*님이 문서 업데이트를 제안했어요:',
    );
    expect(korean.blocks[1].text.text).toBe('```내용이 없어요```');
    // No discussion link in this session, so the context block is absent.
    expect(korean.blocks).toHaveLength(3);
  });

  it('drops the English placeholders unchanged for an English reader', async () => {
    const client = makeClient();

    await updateOtherManagerMessages(
      { managerMessageInfo: { 'M-en': { channel: 'D-en', ts: '2.0' } } },
      'M-actor',
      'Dana',
      client,
      silentLogger(),
    );

    const english = sentTo(client.chat.update, 'D-en');
    expect(english.blocks[0].text.text).toBe(
      "Hi! I'm CHOIR, your documentation assistant.\n*A team member* has a document update suggestion:",
    );
    expect(english.blocks[1].text.text).toBe('```No content available```');
  });
});

describe('notifying the channel the suggestion came from', () => {
  it('follows the workspace default, because the whole channel reads it', async () => {
    const client = makeClient();

    await notifyOriginalChannel({ originalChannelId: 'C1', originalThreadTs: '9.0' }, 'Dana', client, silentLogger());

    expect(tForWorkspace).toHaveBeenCalledWith('T1');
    expect(tForUser).not.toHaveBeenCalled();

    const sent = sentTo(client.chat.postMessage, 'C1');
    expect(sent.thread_ts).toBe('9.0');
    expect(sent.text).toBe('🔄 Dana님이 문서 업데이트 제안을 처리하기 시작했어요.');
    expect(sent.blocks[0].text.text).toBe(
      '🔄 *Dana*님이 문서 업데이트 제안을 처리하기 시작했어요. 잠시 후 DM으로 문서 제안을 보내 드릴게요! 📝',
    );
  });

  it('renders the English wording unchanged when the workspace is English', async () => {
    const client = makeClient();
    tForWorkspace.mockImplementation(async () => createT('en'));

    await notifyOriginalChannel({ originalChannelId: 'C1' }, 'Dana', client, silentLogger());

    const sent = sentTo(client.chat.postMessage, 'C1');
    expect(sent.text).toBe('🔄 Dana started processing your document update suggestion.');
    expect(sent.blocks[0].text.text).toBe(
      "🔄 *Dana* started processing your document update suggestion. You'll receive the document suggestions in your DM shortly! 📝",
    );
  });
});

describe('the manager access-request card', () => {
  const params = {
    userName: 'New Bie',
    requesterUserId: 'U-newbie',
    origin: { channelId: 'C-general', isPublic: true },
    consentFormUrl: 'https://forms.example/consent',
  };

  it('is byte-identical in English to what managers saw before', () => {
    const blocks = buildManagerRequestBlocks(params);

    expect(blocks[0].text.text).toBe('🙋 *New Bie* is requesting access to CHOIR.');
    expect(blocks[1].elements[0].text).toBe(
      "Asked in <#C-general>. Reminder: check they've completed the <https://forms.example/consent|consent form>.",
    );
    expect(blocks[2].elements[0].text.text).toBe('✅ Approve');
    expect(blocks[2].elements[1].text.text).toBe('Decline');
  });

  it('keeps the action ids and values the approve/decline handlers match on', () => {
    const blocks = buildManagerRequestBlocks({ ...params, t: createT('ko') });

    expect(blocks[2].elements.map((element: any) => element.action_id)).toEqual([
      'approve_choir_registration',
      'decline_choir_registration',
    ]);
    expect(blocks[2].elements.map((element: any) => element.value)).toEqual(['U-newbie', 'U-newbie']);
    expect(blocks[2].elements.map((element: any) => element.style)).toEqual(['primary', 'danger']);
  });

  it('builds the whole card in the receiving manager’s language', () => {
    const blocks = buildManagerRequestBlocks({ ...params, t: createT('ko') });

    expect(blocks[0].text.text).toBe('🙋 *New Bie*님이 CHOIR 사용 권한을 요청했어요.');
    expect(blocks[1].elements[0].text).toBe(
      '<#C-general>에서 물어봤어요. 참고: <https://forms.example/consent|동의서> 작성을 마쳤는지 확인해 주세요.',
    );
    expect(blocks[2].elements[0].text.text).toBe('✅ 승인');
    expect(blocks[2].elements[1].text.text).toBe('거절');
  });

  it('switches the origin sentence for a direct message and drops the reminder', () => {
    const blocks = buildManagerRequestBlocks({
      ...params,
      origin: { channelId: 'D1', isPublic: false },
      consentFormUrl: undefined,
    });

    expect(blocks[1].elements[0].text).toBe('Asked in a direct message.');
  });
});

describe('the rate-limit apology', () => {
  it('reads exactly as it did, and follows the translator it is handed', () => {
    expect(createRateLimitNotificationText(createT('en'), 'question')).toBe(
      "⏳ I'm experiencing high traffic and need to slow down a bit. Your question request is being processed but may take a moment longer than usual. Thank you for your patience!",
    );
    expect(createRateLimitNotificationText(createT('ko'), 'question')).toBe(
      '⏳ 요청이 몰려서 조금 천천히 처리하고 있어요. question 요청은 처리 중이지만 평소보다 시간이 조금 더 걸릴 수 있어요. 기다려 주셔서 고마워요!',
    );
  });
});
