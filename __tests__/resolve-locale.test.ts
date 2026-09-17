import type { WebClient } from '@slack/web-api';

const getUserLanguage = jest.fn();
const getWorkspaceLanguage = jest.fn();
const getContentLanguage = jest.fn();
const getUserLocale = jest.fn();
const getCachedUserLocale = jest.fn();

jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: jest.fn().mockImplementation(() => ({
    getUserLanguage,
    getWorkspaceLanguage,
    getContentLanguage,
  })),
}));

jest.mock('services/common/name-cache', () => ({
  getUserLocale: (...args: unknown[]) => getUserLocale(...args),
  getCachedUserLocale: (...args: unknown[]) => getCachedUserLocale(...args),
}));

import { getRequestLocale, localeMiddleware } from 'services/i18n/locale-middleware';
import {
  resolveContentLanguage,
  resolveLocaleForUser,
  resolveLocaleForUserCached,
  resolvePersonalLocaleCached,
  resolveWorkspaceLocale,
} from 'services/i18n/resolve-locale';

const client = {} as WebClient;

describe('locale resolution precedence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The "nothing configured anywhere" baseline each test overrides one step of.
    getUserLanguage.mockResolvedValue(null);
    getWorkspaceLanguage.mockResolvedValue('en');
    getUserLocale.mockResolvedValue(undefined);
    getCachedUserLocale.mockReturnValue(undefined);
  });

  it('1. prefers the user’s explicit setting over everything else', async () => {
    getUserLanguage.mockResolvedValue('ko');
    getUserLocale.mockResolvedValue('en-US');
    getWorkspaceLanguage.mockResolvedValue('en');

    expect(await resolveLocaleForUser('T1', 'U1', client)).toBe('ko');
    // An explicit setting settles it — no reason to ask Slack.
    expect(getUserLocale).not.toHaveBeenCalled();
  });

  it('2. falls back to the Slack locale when the user has no setting', async () => {
    getUserLocale.mockResolvedValue('ko-KR');
    getWorkspaceLanguage.mockResolvedValue('en');

    expect(await resolveLocaleForUser('T1', 'U1', client)).toBe('ko');
    expect(getUserLocale).toHaveBeenCalledWith('U1', client);
  });

  it('3. falls back to the workspace default when Slack has no locale', async () => {
    getWorkspaceLanguage.mockResolvedValue('ko');

    expect(await resolveLocaleForUser('T1', 'U1', client)).toBe('ko');
  });

  it('4. falls back to DEFAULT_LOCALE when the workspace has no default either', async () => {
    // getWorkspaceLanguage itself applies `?? DEFAULT_LOCALE`.
    expect(await resolveLocaleForUser('T1', 'U1', client)).toBe('en');
  });

  it('skips an unsupported Slack locale instead of answering English', async () => {
    getUserLocale.mockResolvedValue('fr-FR');
    getWorkspaceLanguage.mockResolvedValue('ko');

    // A French Slack account is not a vote for English: the workspace default
    // still wins, because we have no French strings to give them.
    expect(await resolveLocaleForUser('T1', 'U1', client)).toBe('ko');
  });

  it('normalizes a supported region tag to its language', async () => {
    getUserLocale.mockResolvedValue('en-GB');
    getWorkspaceLanguage.mockResolvedValue('ko');

    expect(await resolveLocaleForUser('T1', 'U1', client)).toBe('en');
  });
});

describe('cached resolution (no Slack call)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getUserLanguage.mockResolvedValue(null);
    getWorkspaceLanguage.mockResolvedValue('en');
    getUserLocale.mockResolvedValue('ko-KR');
    getCachedUserLocale.mockReturnValue(undefined);
  });

  it('never calls the Slack-fetching variant', async () => {
    getWorkspaceLanguage.mockResolvedValue('ko');

    expect(await resolveLocaleForUserCached('T1', 'U1')).toBe('ko');
    expect(getUserLocale).not.toHaveBeenCalled();
    expect(getCachedUserLocale).toHaveBeenCalledWith('U1');
  });

  it('uses a warm Slack locale when the cache has one', async () => {
    getCachedUserLocale.mockReturnValue('ko-KR');

    expect(await resolveLocaleForUserCached('T1', 'U1')).toBe('ko');
  });

  it('reports the gap so callers can negotiate their own fallback', async () => {
    expect(await resolvePersonalLocaleCached('T1', 'U1')).toBeUndefined();

    getCachedUserLocale.mockReturnValue('ko-KR');
    expect(await resolvePersonalLocaleCached('T1', 'U1')).toBe('ko');

    getUserLanguage.mockResolvedValue('en');
    expect(await resolvePersonalLocaleCached('T1', 'U1')).toBe('en');
  });
});

describe('locale middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getUserLanguage.mockResolvedValue(null);
    getWorkspaceLanguage.mockResolvedValue('en');
    getCachedUserLocale.mockReturnValue(undefined);
  });

  const run = async (args: Record<string, unknown>) => {
    const next = jest.fn();
    const context: Record<string, unknown> = { teamId: 'T1' };
    await localeMiddleware({ context, next, ...args });
    return { context, next };
  };

  it('puts the resolved locale on the Bolt context and continues', async () => {
    getUserLanguage.mockResolvedValue('ko');
    const { context, next } = await run({ body: { user: { id: 'U1' } }, event: undefined });

    expect(context.locale).toBe('ko');
    expect(getRequestLocale(context)).toBe('ko');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default and still continues when resolution fails', async () => {
    getUserLanguage.mockRejectedValue(new Error('db is on fire'));
    const { context, next } = await run({ body: { user: { id: 'U1' } }, event: undefined });

    expect(context.locale).toBe('en');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('defaults without touching the store when the payload has no user', async () => {
    const { context, next } = await run({ body: {}, event: {} });

    expect(context.locale).toBe('en');
    expect(getUserLanguage).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('getRequestLocale ignores junk', () => {
    expect(getRequestLocale(undefined)).toBe('en');
    expect(getRequestLocale({})).toBe('en');
    expect(getRequestLocale({ locale: 'fr' })).toBe('en');
    expect(getRequestLocale({ locale: 'ko' })).toBe('ko');
  });
});

describe('workspace-scoped resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolveWorkspaceLocale ignores any individual', async () => {
    getWorkspaceLanguage.mockResolvedValue('ko');
    expect(await resolveWorkspaceLocale('T1')).toBe('ko');
    expect(getUserLanguage).not.toHaveBeenCalled();
    expect(getCachedUserLocale).not.toHaveBeenCalled();
  });

  it('resolveContentLanguage passes the stored policy through', async () => {
    getContentLanguage.mockResolvedValue('follow-conversation');
    expect(await resolveContentLanguage('T1')).toBe('follow-conversation');

    getContentLanguage.mockResolvedValue('ko');
    expect(await resolveContentLanguage('T1')).toBe('ko');
  });
});
