// The knowledge-extraction surfaces after the catalog migration. Three things
// are worth a test here and nothing else is: that an English workspace sees the
// exact modals it saw before (the fixture was captured from the pre-migration
// code and is diffed byte for byte), that a Korean reader gets a modal Slack
// will actually accept — a title over 24 characters rejects the whole view —
// and that the manager fan-out resolves a language *per recipient* rather than
// reusing the requester's, which is the one bug this shape of code invites.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SLACK_LIMITS, createT, isSupportedLocale } from '../src/i18n';

const getSessionData = jest.fn();
const getWorkspaceId = jest.fn();
const getManagers = jest.fn();
const getUserName = jest.fn();
const getChannelName = jest.fn();
const tForUser = jest.fn();
const tForWorkspace = jest.fn();
const tForRequest = jest.fn();

jest.mock('services/common', () => ({
  SessionType: { DOCUMENT_UPDATE: 'document_update' },
  getSessionData: (...args: unknown[]) => getSessionData(...args),
  storeSessionData: jest.fn(),
}));

jest.mock('services/common/interaction-tracker', () => ({
  logButtonClick: jest.fn(),
  logModalSubmit: jest.fn(),
}));

jest.mock('services/slack', () => ({
  getWorkspaceId: (...args: unknown[]) => getWorkspaceId(...args),
  getManagers: (...args: unknown[]) => getManagers(...args),
  getUserName: (...args: unknown[]) => getUserName(...args),
  getChannelName: (...args: unknown[]) => getChannelName(...args),
}));

// The suggestion handler drags in the whole document pipeline; only its link
// helper is reachable from this feature.
jest.mock('../listeners/features/document-update/suggestions/suggest-updates-handler', () => ({
  __esModule: true,
  default: jest.fn(),
  createMessageLink: () => 'https://acme.slack.com/archives/C1/p1',
}));

jest.mock('services/i18n', () => ({
  tForRequest: (...args: unknown[]) => tForRequest(...args),
  tForUser: (...args: unknown[]) => tForUser(...args),
  tForWorkspace: (...args: unknown[]) => tForWorkspace(...args),
}));

import { editExtractedKnowledgeCallback } from '../listeners/features/document-update/extract-knowledge/edit-extracted-knowledge-action';
import { openKnowledgeEditManagerModalCallback } from '../listeners/features/document-update/extract-knowledge/open-knowledge-edit-manager-modal-action';
import { sendUpdateSuggestionToManagerCallback } from '../listeners/features/document-update/extract-knowledge/send-update-suggestion-to-manager-action';

/** Two managers in one workspace who read CHOIR in different languages. */
const LOCALE_BY_USER: Record<string, 'en' | 'ko'> = { 'M-en': 'en', 'M-ko': 'ko' };

const SESSION = {
  extractedKnowledge: 'Travel is reimbursed within 30 days.',
  messages: [{ ts: '1' }, { ts: '2' }, { ts: '3' }],
  userId: 'U-alice',
  originalChannelId: 'C1',
  originalThreadTs: '9.0',
};

const silentLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

/** The postMessage payload addressed to `channel`. */
const sentTo = (fn: jest.Mock, channel: string) =>
  fn.mock.calls.map(([arg]) => arg).find((arg) => arg.channel === channel);

beforeEach(() => {
  jest.clearAllMocks();
  getSessionData.mockReturnValue({ ...SESSION });
  getWorkspaceId.mockResolvedValue('T1');
  getManagers.mockResolvedValue([]);
  getUserName.mockImplementation(async (id: string) => id);
  getChannelName.mockResolvedValue('general');
  tForRequest.mockImplementation((context: any) => createT(isSupportedLocale(context?.locale) ? context.locale : 'en'));
  tForUser.mockImplementation(async (_workspaceId: string, userId: string) => createT(LOCALE_BY_USER[userId] ?? 'en'));
  tForWorkspace.mockImplementation(async () => createT('ko'));
});

/** Opens one of the two knowledge modals and hands back the view Slack got. */
async function openModal(callback: any, locale: 'en' | 'ko') {
  const client = {
    views: { open: jest.fn(async () => ({ ok: true })) },
    chat: { postMessage: jest.fn(async () => ({ ok: true })) },
  };
  await callback({
    ack: async () => {},
    body: { user: { id: 'M-en' }, trigger_id: 'T', actions: [{ value: 'sess-1' }], channel: { id: 'C1' } },
    client,
    logger: silentLogger(),
    context: { locale },
  });
  return client.views.open.mock.calls[0][0].view as any;
}

describe('the knowledge edit modals in English', () => {
  // Captured by running the handlers before the migration, so a diff here is a
  // change an English workspace would actually see.
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'doc-update-extract-en.json'), 'utf8'));

  it('renders the requester’s modal byte for byte as it did before', async () => {
    expect(await openModal(editExtractedKnowledgeCallback, 'en')).toEqual(fixture.knowledge_edit_modal);
  });

  it('renders the manager’s modal byte for byte as it did before', async () => {
    expect(await openModal(openKnowledgeEditManagerModalCallback, 'en')).toEqual(fixture.knowledge_edit_manager_modal);
  });
});

describe('the knowledge edit modals in Korean', () => {
  it('translates every label of the requester’s modal', async () => {
    const view = await openModal(editExtractedKnowledgeCallback, 'ko');

    expect(view.title.text).toBe('지식 수정');
    expect(view.submit.text).toBe('지식 업데이트');
    expect(view.close.text).toBe('취소');
    expect(view.blocks[0].text.text).toBe('*업데이트를 적용하기 전에 추출된 지식을 수정해 주세요:* ');
    expect(view.blocks[1].label.text).toBe('지식 내용');
    expect(view.blocks[1].element.placeholder.text).toBe('문서로 남길 지식을 입력해 주세요...');
    // Korean has one cardinal form, so three messages read the same as one.
    expect(view.blocks[2].elements[0].text).toBe('📊 *출처:* 메시지 3개를 분석했어요');
  });

  it('translates every label of the manager’s modal', async () => {
    const view = await openModal(openKnowledgeEditManagerModalCallback, 'ko');

    expect(view.title.text).toBe('제출된 지식 수정');
    expect(view.submit.text).toBe('지식 업데이트');
    expect(view.close.text).toBe('취소');
    expect(view.blocks[0].text.text).toBe('*사용자가 제출한 지식을 수정해 주세요:*');
    expect(view.blocks[1].label.text).toBe('지식 내용');
  });

  it('keeps both modals inside Slack’s title and button caps, which reject the view', async () => {
    for (const callback of [editExtractedKnowledgeCallback, openKnowledgeEditManagerModalCallback]) {
      for (const locale of ['en', 'ko'] as const) {
        const view = await openModal(callback, locale);
        expect(view.title.text.length).toBeLessThanOrEqual(SLACK_LIMITS.title);
        expect(view.submit.text.length).toBeLessThanOrEqual(SLACK_LIMITS.button);
        expect(view.close.text.length).toBeLessThanOrEqual(SLACK_LIMITS.button);
      }
    }
  });

  it('leaves the ids the submit handlers route on untouched', async () => {
    const view = await openModal(editExtractedKnowledgeCallback, 'ko');

    expect(view.callback_id).toBe('knowledge_edit_modal');
    expect(view.private_metadata).toBe('sess-1');
    expect(view.blocks[1].block_id).toBe('knowledge_input');
    expect(view.blocks[1].element.action_id).toBe('knowledge_text');
  });
});

describe('handing the suggestion to the managers', () => {
  function makeClient() {
    return {
      chat: { postMessage: jest.fn(async () => ({ ok: true, ts: '1.1' })) },
      users: { info: jest.fn(async () => ({ user: { profile: { display_name: 'Alice', image_192: 'http://i/1' } } })) },
      conversations: { info: jest.fn(async () => ({ ok: true, channel: { is_channel: false } })) },
      auth: { test: jest.fn(async () => ({ url: 'https://acme.slack.com/' })) },
    } as any;
  }

  const run = async (client: any) =>
    sendUpdateSuggestionToManagerCallback({
      ack: async () => {},
      body: { user: { id: 'U-alice' }, actions: [{ value: 'sess-1' }], channel: { id: 'C1' } },
      client,
      logger: silentLogger(),
      context: { locale: 'en' },
    } as any);

  it('writes each manager’s card in that manager’s language, not the requester’s', async () => {
    const client = makeClient();
    getManagers.mockResolvedValue(['M-en', 'M-ko']);

    await run(client);

    // One resolution per recipient, with the client, since a manager may never
    // have been looked up before.
    expect(tForUser).toHaveBeenCalledWith('T1', 'M-en', client);
    expect(tForUser).toHaveBeenCalledWith('T1', 'M-ko', client);

    const english = sentTo(client.chat.postMessage, 'M-en');
    expect(english.text).toBe('📝 New document update suggestion from *Alice* for your review.');
    expect(english.blocks[0].text.text).toBe(
      "Hi! I'm CHOIR, your documentation assistant.\n \n \n*Alice* has a document update suggestion:",
    );
    expect(english.blocks[2].elements.map((element: any) => element.text.text)).toEqual([
      '✏️ Edit Suggestion',
      '🚀 Start Update Process',
      'Decline',
    ]);

    const korean = sentTo(client.chat.postMessage, 'M-ko');
    expect(korean.text).toBe('📝 *Alice*님이 보낸 새 문서 업데이트 제안이에요. 검토해 주세요.');
    expect(korean.blocks[0].text.text).toBe(
      '안녕하세요, 문서 도우미 CHOIR예요.\n \n \n*Alice*님이 문서 업데이트를 제안했어요:',
    );
    expect(korean.blocks[2].elements.map((element: any) => element.text.text)).toEqual([
      '✏️ 제안 수정',
      '🚀 업데이트 진행 시작',
      '거절',
    ]);
  });

  it('never builds a manager’s card from the requester’s translator', async () => {
    const client = makeClient();
    getManagers.mockResolvedValue(['M-ko']);
    // The actor reads English; the card must not follow them.
    tForRequest.mockImplementation(() => createT('en'));

    await run(client);

    expect(sentTo(client.chat.postMessage, 'M-ko').blocks[0].text.text).toContain('안녕하세요');
  });

  it('keeps the action ids and values the manager buttons route on', async () => {
    const client = makeClient();
    getManagers.mockResolvedValue(['M-ko']);

    await run(client);

    const elements = sentTo(client.chat.postMessage, 'M-ko').blocks[2].elements;
    expect(elements.map((element: any) => element.action_id)).toEqual([
      'open_knowledge_edit_manager_modal',
      'suggest_updates',
      'cancel_knowledge_extraction',
    ]);
    expect(elements[0].value).toBe('sess-1');
    expect(JSON.parse(elements[1].value)).toEqual({
      sessionId: 'sess-1',
      originalChannelId: 'C1',
      originalThreadTs: '9.0',
      continueToFileSelection: true,
    });
  });

  it('confirms in the channel in the workspace language, counting the managers', async () => {
    const client = makeClient();
    getManagers.mockResolvedValue(['M-en', 'M-ko']);
    tForWorkspace.mockImplementation(async () => createT('en'));

    await run(client);

    const confirmation = sentTo(client.chat.postMessage, 'C1');
    expect(tForWorkspace).toHaveBeenCalledWith('T1');
    expect(confirmation.blocks[0].text.text).toBe(
      "✅ Great news, *Alice*! Your document update suggestion has been successfully sent to our managers: *M-en*, *M-ko*. They'll review it soon!",
    );
    // The preview names the channel the suggestion came from; the block does not.
    expect(confirmation.text).toBe(
      "✅ Great news, *Alice*! Your document update suggestion has been successfully sent to our managers: *M-en*, *M-ko*. They'll review it soon! (Sent from channel: #general)",
    );
  });

  it('says "manager", not "manager(s)", when there is exactly one', async () => {
    const client = makeClient();
    getManagers.mockResolvedValue(['M-en']);
    tForWorkspace.mockImplementation(async () => createT('en'));

    await run(client);

    expect(sentTo(client.chat.postMessage, 'C1').blocks[0].text.text).toBe(
      "✅ Great news, *Alice*! Your document update suggestion has been successfully sent to our manager: *M-en*. They'll review it soon!",
    );
  });

  it('tells the requester in their own language when there is no channel to post in', async () => {
    const client = makeClient();
    getManagers.mockResolvedValue(['M-en', 'M-ko']);
    getSessionData.mockReturnValue({ ...SESSION, originalChannelId: undefined });

    await run(client);

    expect(sentTo(client.chat.postMessage, 'U-alice').text).toBe(
      '✅ Your update suggestion has been passed to 2 managers for review. They will be able to apply the suggestion to update documents or provide feedback.',
    );
  });
});
