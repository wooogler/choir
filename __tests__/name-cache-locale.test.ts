import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';

type NameCacheModule = typeof import('services/common/name-cache');

/**
 * The name cache is a module-level singleton that reads CHOIR_DATA_DIR in its
 * constructor, so each test gets a fresh temp dir and a freshly required module
 * rather than sharing one on-disk cache file.
 */
function loadNameCache(dataDir: string): NameCacheModule {
  process.env.CHOIR_DATA_DIR = dataDir;
  let mod!: NameCacheModule;
  jest.isolateModules(() => {
    mod = require('services/common/name-cache');
  });
  return mod;
}

function makeClient(user: Record<string, unknown> | undefined) {
  const info = jest.fn().mockResolvedValue({ user });
  return {
    client: {
      users: { info },
      auth: { test: jest.fn().mockResolvedValue({ user_id: 'UBOT' }) },
    } as unknown as WebClient,
    info,
  };
}

describe('name cache locale', () => {
  let tempDir: string;
  const originalDataDir = process.env.CHOIR_DATA_DIR;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-namecache-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) {
      Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
    } else {
      process.env.CHOIR_DATA_DIR = originalDataDir;
    }
  });

  it('fetches the locale once and serves later lookups from cache', async () => {
    const { getUserLocale, getCachedUserLocale } = loadNameCache(tempDir);
    const { client, info } = makeClient({ real_name: 'Ada', locale: 'ko-KR' });

    expect(await getUserLocale('U1', client)).toBe('ko-KR');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith({ user: 'U1', include_locale: true });

    expect(await getUserLocale('U1', client)).toBe('ko-KR');
    expect(info).toHaveBeenCalledTimes(1);
    expect(getCachedUserLocale('U1')).toBe('ko-KR');
  });

  it('back-fills the locale from a name lookup, for free', async () => {
    const { getCachedUserName, getCachedUserLocale } = loadNameCache(tempDir);
    const { client, info } = makeClient({ real_name: 'Ada', locale: 'ko-KR' });

    expect(await getCachedUserName('U1', client)).toBe('Ada');
    // The name call already asked for the locale, so it is there with no
    // second round-trip.
    expect(getCachedUserLocale('U1')).toBe('ko-KR');
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('remembers that a user simply has no locale, instead of re-asking', async () => {
    const { getUserLocale } = loadNameCache(tempDir);
    const { client, info } = makeClient({ real_name: 'Ada' });

    expect(await getUserLocale('U1', client)).toBeUndefined();
    expect(await getUserLocale('U1', client)).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('reports no cached locale for an unknown user and makes no call', () => {
    const { getCachedUserLocale } = loadNameCache(tempDir);
    expect(getCachedUserLocale('U-nobody')).toBeUndefined();
  });

  it('survives a failed lookup', async () => {
    const { getUserLocale } = loadNameCache(tempDir);
    const client = {
      users: { info: jest.fn().mockRejectedValue(new Error('missing_scope')) },
      auth: { test: jest.fn().mockResolvedValue({ user_id: 'UBOT' }) },
    } as unknown as WebClient;

    expect(await getUserLocale('U1', client)).toBeUndefined();
  });
});
