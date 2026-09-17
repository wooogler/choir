// `services/i18n/t` is three one-line wrappers, and the line that matters in
// each is *which* resolver it picks: a translator bound to the wrong person is
// invisible in English and only shows up as a Korean manager reading English.
// So these tests assert the routing (and the cost — whether Slack is called),
// with the resolvers themselves mocked; their precedence is resolve-locale's.

import type { WebClient } from '@slack/web-api';

const resolveLocaleForUser = jest.fn();
const resolveLocaleForUserCached = jest.fn();
const resolveWorkspaceLocale = jest.fn();

jest.mock('services/i18n/resolve-locale', () => ({
  resolveLocaleForUser: (...args: unknown[]) => resolveLocaleForUser(...args),
  resolveLocaleForUserCached: (...args: unknown[]) => resolveLocaleForUserCached(...args),
  resolveWorkspaceLocale: (...args: unknown[]) => resolveWorkspaceLocale(...args),
}));

import { tForRequest, tForUser, tForWorkspace } from 'services/i18n/t';

const client = {} as WebClient;

beforeEach(() => {
  jest.clearAllMocks();
  resolveLocaleForUser.mockResolvedValue('ko');
  resolveLocaleForUserCached.mockResolvedValue('en');
  resolveWorkspaceLocale.mockResolvedValue('ko');
});

describe('tForUser', () => {
  it('uses the network resolver only when a client is passed', async () => {
    const t = await tForUser('T1', 'U-cold', client);

    expect(t.locale).toBe('ko');
    expect(resolveLocaleForUser).toHaveBeenCalledWith('T1', 'U-cold', client);
    expect(resolveLocaleForUserCached).not.toHaveBeenCalled();
  });

  it('stays off the network when no client is passed', async () => {
    const t = await tForUser('T1', 'U-warm');

    expect(t.locale).toBe('en');
    expect(resolveLocaleForUserCached).toHaveBeenCalledWith('T1', 'U-warm');
    expect(resolveLocaleForUser).not.toHaveBeenCalled();
  });

  it('binds the recipient, not the workspace', async () => {
    resolveLocaleForUser.mockResolvedValue('ko');
    const t = await tForUser('T1', 'U-manager', client);

    expect(t('common.button.cancel')).toBe('취소');
    expect(resolveWorkspaceLocale).not.toHaveBeenCalled();
  });
});

describe('tForWorkspace', () => {
  it('asks only the workspace default, never an individual', async () => {
    const t = await tForWorkspace('T1');

    expect(t.locale).toBe('ko');
    expect(resolveWorkspaceLocale).toHaveBeenCalledWith('T1');
    expect(resolveLocaleForUser).not.toHaveBeenCalled();
    expect(resolveLocaleForUserCached).not.toHaveBeenCalled();
  });
});

describe('tForRequest', () => {
  it('reads the locale the middleware stamped on the context', () => {
    expect(tForRequest({ locale: 'ko' }).locale).toBe('ko');
  });

  it('costs nothing — no resolver is consulted', () => {
    tForRequest({ locale: 'ko' });

    expect(resolveLocaleForUser).not.toHaveBeenCalled();
    expect(resolveLocaleForUserCached).not.toHaveBeenCalled();
    expect(resolveWorkspaceLocale).not.toHaveBeenCalled();
  });

  it('falls back to English on junk context rather than throwing', () => {
    expect(tForRequest(undefined).locale).toBe('en');
    expect(tForRequest(null).locale).toBe('en');
    expect(tForRequest({}).locale).toBe('en');
    expect(tForRequest({ locale: 'fr' }).locale).toBe('en');
    expect(tForRequest('nonsense').locale).toBe('en');
    expect(tForRequest({ locale: 42 })('common.button.cancel')).toBe('Cancel');
  });
});
