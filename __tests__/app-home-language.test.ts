// The language controls on App Home: what the blocks say about the stored
// settings, who is allowed to see the workspace-wide half, and what the three
// handlers actually write.

const getUserLanguage = jest.fn();
const setUserLanguage = jest.fn();
const getWorkspaceLanguage = jest.fn();
const setWorkspaceLanguage = jest.fn();
const getContentLanguage = jest.fn();
const setContentLanguage = jest.fn();
const resolveLocaleForUser = jest.fn();
const requireManagerForAction = jest.fn();
const refreshAppHomeSoon = jest.fn();
const refreshAppHomeSoonPreferences = jest.fn();
const logAppHomeButtonClick = jest.fn();

jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: jest.fn().mockImplementation(() => ({
    getUserLanguage,
    setUserLanguage,
    getWorkspaceLanguage,
    setWorkspaceLanguage,
    getContentLanguage,
    setContentLanguage,
  })),
}));

jest.mock('services/slack', () => ({
  getWorkspaceId: jest.fn(async () => 'T1'),
}));

jest.mock('services/common/interaction-tracker', () => ({
  logAppHomeButtonClick: (...args: unknown[]) => logAppHomeButtonClick(...args),
}));

// `services/i18n` is stubbed rather than required-actual so the handlers' only
// network-ish dependency (the resolver) is controllable; `tForRequest` is kept
// faithful because the confirmations' language is what these tests are about.
jest.mock('services/i18n', () => {
  const { createT, isSupportedLocale } = jest.requireActual('../src/i18n');
  return {
    resolveLocaleForUser: (...args: unknown[]) => resolveLocaleForUser(...args),
    tForRequest: (context: any) => createT(isSupportedLocale(context?.locale) ? context.locale : 'en'),
  };
});

jest.mock('../listeners/features/app-home/management/shared', () => ({
  requireManagerForAction: (...args: unknown[]) => requireManagerForAction(...args),
  refreshAppHomeSoon: (...args: unknown[]) => refreshAppHomeSoon(...args),
  logManagementButtonError: jest.fn(),
}));

jest.mock('../listeners/features/app-home/refresh', () => ({
  refreshAppHomeSoon: (...args: unknown[]) => refreshAppHomeSoonPreferences(...args),
}));

import {
  buildContentLanguageRow,
  buildMyLanguageRow,
  buildWorkspaceLanguageRow,
} from '../listeners/features/app-home/home-view-builder';
import { registerLanguageHandlers as registerWorkspaceLanguageHandlers } from '../listeners/features/app-home/management/language-handlers';
import { registerLanguageHandlers as registerMyLanguageHandler } from '../listeners/features/preferences/language-handlers';
import { createT } from '../src/i18n';

const en = createT('en');
const ko = createT('ko');

describe('per-user language row', () => {
  it('shows the stored preference as the initial option', () => {
    const select = buildMyLanguageRow(en, 'ko').accessory;

    expect(select.action_id).toBe('set_my_language');
    expect(select.initial_option.value).toBe('ko');
    expect(select.options.map((option: any) => option.value)).toEqual(['auto', 'en', 'ko']);
  });

  it('shows Automatic when the user has no preference stored', () => {
    const select = buildMyLanguageRow(en, null).accessory;

    expect(select.initial_option.value).toBe('auto');
    expect(select.initial_option.text.text).toBe(en('appHome.language.option.auto'));
  });

  it('renders in the reader’s own language', () => {
    const select = buildMyLanguageRow(ko, 'en').accessory;

    expect(select.initial_option.value).toBe('en');
    expect(select.options[0].text.text).toBe(ko('appHome.language.option.auto'));
    expect(select.options[0].text.text).not.toBe(en('appHome.language.option.auto'));
  });
});

// The two manager-only settings now live on separate tabs — the workspace
// default on Team, the document policy on Documents — so each is one row with
// one select. Who may see them is the tab gate's business, not the row's.
describe('workspace language row (Team tab)', () => {
  it('is a single section carrying the stored value', () => {
    const block = buildWorkspaceLanguageRow(en, 'ko');

    expect(block.type).toBe('section');
    expect(block.text.text).toContain(en('appHome.language.workspace.label'));
    expect(block.text.text).toContain(en('appHome.language.workspace.context'));
    expect(block.accessory.action_id).toBe('set_workspace_language');
    expect(block.accessory.initial_option.value).toBe('ko');
    expect(block.accessory.options.map((o: any) => o.value)).toEqual(['en', 'ko']);
  });
});

describe('document content language row (Documents tab)', () => {
  it('lists follow-conversation first and keeps the stored value selected', () => {
    const block = buildContentLanguageRow(en, 'en');

    expect(block.accessory.action_id).toBe('set_content_language');
    expect(block.accessory.initial_option.value).toBe('en');
    expect(block.accessory.options.map((o: any) => o.value)).toEqual(['follow-conversation', 'en', 'ko']);
  });

  it('defaults to follow-conversation', () => {
    expect(buildContentLanguageRow(en, 'follow-conversation').accessory.initial_option.value).toBe(
      'follow-conversation',
    );
  });
});

type Handlers = Map<string, (args: any) => Promise<void>>;

const collectHandlers = (register: (app: any) => void): Handlers => {
  const handlers: Handlers = new Map();
  register({ action: (id: string, fn: any) => handlers.set(id, fn) });
  return handlers;
};

const makeArgs = (value: unknown, contextLocale = 'en') => {
  const postEphemeral = jest.fn(async () => ({ ok: true }));
  return {
    postEphemeral,
    args: {
      ack: jest.fn(async () => undefined),
      body: { user: { id: 'U1' }, actions: [{ selected_option: { value } }] },
      client: { chat: { postEphemeral } },
      context: { locale: contextLocale },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    },
  };
};

describe('set_my_language handler', () => {
  const handler = () => collectHandlers(registerMyLanguageHandler).get('set_my_language') as any;

  beforeEach(() => {
    jest.clearAllMocks();
    resolveLocaleForUser.mockResolvedValue('ko');
  });

  it('stores the chosen locale and confirms in that language', async () => {
    const { args, postEphemeral } = makeArgs('ko');
    await handler()(args);

    expect(setUserLanguage).toHaveBeenCalledWith('T1', 'U1', 'ko');
    expect(postEphemeral.mock.calls[0][0].text).toBe(
      ko('appHome.language.confirm.mine', { language: ko('appHome.language.option.korean') }),
    );
    expect(postEphemeral.mock.calls[0][0].text).toContain('한국어');
    expect(refreshAppHomeSoonPreferences).toHaveBeenCalledTimes(1);
    expect(logAppHomeButtonClick).toHaveBeenCalled();
  });

  it('clears the preference for Automatic and confirms in the resolved language', async () => {
    const { args, postEphemeral } = makeArgs('auto');
    await handler()(args);

    expect(setUserLanguage).toHaveBeenCalledWith('T1', 'U1', null);
    // Resolution happens after the clear, so the confirmation names what
    // "automatic" now actually works out to.
    expect(resolveLocaleForUser).toHaveBeenCalledWith('T1', 'U1', args.client);
    expect(postEphemeral.mock.calls[0][0].text).toBe(
      ko('appHome.language.confirm.mineAuto', { language: ko('appHome.language.option.korean') }),
    );
  });

  it('writes nothing for a locale CHOIR has no strings for', async () => {
    const { args, postEphemeral } = makeArgs('xx');
    await handler()(args);

    expect(setUserLanguage).not.toHaveBeenCalled();
    expect(args.logger.warn).toHaveBeenCalled();
    expect(postEphemeral.mock.calls[0][0].text).toBe(en('common.error.generic'));
    expect(refreshAppHomeSoonPreferences).not.toHaveBeenCalled();
  });
});

describe('workspace language handlers', () => {
  const handlers = () => collectHandlers(registerWorkspaceLanguageHandlers);

  beforeEach(() => {
    jest.clearAllMocks();
    requireManagerForAction.mockResolvedValue(true);
  });

  it('set_workspace_language stores the locale and confirms', async () => {
    const { args, postEphemeral } = makeArgs('ko', 'ko');
    await (handlers().get('set_workspace_language') as any)(args);

    expect(setWorkspaceLanguage).toHaveBeenCalledWith('T1', 'ko');
    expect(postEphemeral.mock.calls[0][0].text).toBe(
      ko('appHome.language.confirm.workspace', { language: ko('appHome.language.option.korean') }),
    );
    expect(refreshAppHomeSoon).toHaveBeenCalledTimes(1);
  });

  it('set_content_language accepts the follow-conversation policy', async () => {
    const { args, postEphemeral } = makeArgs('follow-conversation');
    await (handlers().get('set_content_language') as any)(args);

    expect(setContentLanguage).toHaveBeenCalledWith('T1', 'follow-conversation');
    expect(postEphemeral.mock.calls[0][0].text).toBe(
      en('appHome.language.confirm.content', { language: en('appHome.language.option.followConversation') }),
    );
  });

  it('reject an unsupported value without writing', async () => {
    const workspace = makeArgs('xx');
    await (handlers().get('set_workspace_language') as any)(workspace.args);
    const content = makeArgs('xx');
    await (handlers().get('set_content_language') as any)(content.args);

    expect(setWorkspaceLanguage).not.toHaveBeenCalled();
    expect(setContentLanguage).not.toHaveBeenCalled();
    expect(workspace.postEphemeral.mock.calls[0][0].text).toBe(en('common.error.generic'));
    expect(content.postEphemeral.mock.calls[0][0].text).toBe(en('common.error.generic'));
  });

  it('write nothing when the actor is not a manager', async () => {
    requireManagerForAction.mockResolvedValue(false);
    const { args, postEphemeral } = makeArgs('ko');

    await (handlers().get('set_workspace_language') as any)(args);
    await (handlers().get('set_content_language') as any)(args);

    expect(setWorkspaceLanguage).not.toHaveBeenCalled();
    expect(setContentLanguage).not.toHaveBeenCalled();
    // The denial notice is `requireManagerForAction`'s own business.
    expect(postEphemeral).not.toHaveBeenCalled();
  });
});
