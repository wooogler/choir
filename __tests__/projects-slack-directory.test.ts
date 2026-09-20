/**
 * The Slack side of project folders, against a fake WebClient.
 *
 * What matters here is what the GUI depends on and what the workspace pays for:
 * every page of a large channel is read, bots and deleted accounts do not become
 * project members, the second open of a dialog costs no API calls, and the one
 * error a manager can fix (`missing_scope`) arrives as its own code rather than
 * as "Slack is down".
 */

import type { WebClient } from '@slack/web-api';

let repoRoot = '';

jest.mock('services/workspace/mirror-service', () => ({
  WorkspaceMirrorService: { getInstance: () => ({ getRepoRoot: () => repoRoot }) },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearProjectIndexCache } from '../services/projects/project-index';
import { ProjectRefusal } from '../services/projects/refusal';
import {
  channelMembers,
  clearSlackDirectoryCache,
  listChannels,
  privateChannelsReadable,
  projectMembers,
} from '../services/projects/slack-directory';

const WS = 'T1';

/** A Slack API error carries its reason on `data.error`, which is what the mapping reads. */
function slackError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { data: { error: code, ...extra } });
}

interface FakeOptions {
  channelPages?: Array<{ channels: unknown[]; next?: string }>;
  memberPages?: Record<string, Array<{ members: string[]; next?: string }>>;
  users?: Record<string, unknown>;
  listError?: Error;
  membersError?: Error;
}

function fakeClient(options: FakeOptions) {
  const calls = { list: 0, members: 0, info: 0 };
  const client = {
    token: 'xoxb-fake',
    conversations: {
      list: jest.fn(async ({ cursor }: { cursor?: string; types?: string }) => {
        calls.list += 1;
        if (options.listError) throw options.listError;
        const pages = options.channelPages ?? [{ channels: [] }];
        const page = cursor ? pages[Number(cursor)] : pages[0];
        return { channels: page.channels, response_metadata: { next_cursor: page.next ?? '' } };
      }),
      members: jest.fn(async ({ channel, cursor }: { channel: string; cursor?: string }) => {
        calls.members += 1;
        if (options.membersError) throw options.membersError;
        const pages = options.memberPages?.[channel] ?? [{ members: [] }];
        const page = cursor ? pages[Number(cursor)] : pages[0];
        return { members: page.members, response_metadata: { next_cursor: page.next ?? '' } };
      }),
    },
    users: {
      info: jest.fn(async ({ user }: { user: string }) => {
        calls.info += 1;
        const known = options.users?.[user];
        if (!known) throw slackError('user_not_found');
        return { user: known };
      }),
    },
  };
  return { client: client as unknown as WebClient, calls, spies: client };
}

function person(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, real_name: name, profile: { title: `${name}'s title`, image_72: `https://img/${id}` }, ...extra };
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-slack-dir-'));
  clearSlackDirectoryCache();
  clearProjectIndexCache();
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('listChannels', () => {
  it('follows the cursor and keeps archived channels', async () => {
    const { client, calls } = fakeClient({
      channelPages: [
        { channels: [{ id: 'C1', name: 'general', num_members: 12 }], next: '1' },
        { channels: [{ id: 'G2', name: 'secret', is_private: true, is_archived: true }] },
      ],
    });

    await expect(listChannels(client)).resolves.toEqual([
      { id: 'C1', name: 'general', isPrivate: false, isArchived: false, memberCount: 12 },
      { id: 'G2', name: 'secret', isPrivate: true, isArchived: true, memberCount: undefined },
    ]);
    expect(calls.list).toBe(2);
  });

  it('asks for private channels too, and never hides archived ones', async () => {
    const { client, spies } = fakeClient({ channelPages: [{ channels: [] }] });
    await listChannels(client);
    expect(spies.conversations.list).toHaveBeenCalledWith(
      expect.objectContaining({ types: 'public_channel,private_channel', exclude_archived: false }),
    );
  });

  it('turns a missing scope into the code the manager can act on', async () => {
    const { client } = fakeClient({ listError: slackError('missing_scope', { needed: 'groups:read' }) });

    const refusal = await listChannels(client).catch((err) => err);
    expect(refusal).toBeInstanceOf(ProjectRefusal);
    expect(refusal.status).toBe(403);
    expect(refusal.apiCode).toBe('slack_scope_missing');
    expect(refusal.detail).toEqual({ scope: 'groups:read' });
  });

  it('turns anything else into slack_unavailable', async () => {
    const { client } = fakeClient({ listError: slackError('ratelimited') });

    const refusal = await listChannels(client).catch((err) => err);
    expect(refusal.status).toBe(503);
    expect(refusal.apiCode).toBe('slack_unavailable');
    expect(refusal.detail).toEqual({ message: 'ratelimited' });
  });
});

describe('privateChannelsReadable', () => {
  it('is false without the scope and true with it, and is asked once', async () => {
    const withoutScope = fakeClient({ listError: slackError('missing_scope', { needed: 'groups:read' }) });
    await expect(privateChannelsReadable(withoutScope.client, WS)).resolves.toBe(false);
    await expect(privateChannelsReadable(withoutScope.client, WS)).resolves.toBe(false);
    expect(withoutScope.calls.list).toBe(1);

    clearSlackDirectoryCache();
    const withScope = fakeClient({ channelPages: [{ channels: [] }] });
    await expect(privateChannelsReadable(withScope.client, WS)).resolves.toBe(true);
  });
});

describe('channelMembers', () => {
  const options: FakeOptions = {
    memberPages: { C1: [{ members: ['U1', 'U2'], next: '1' }, { members: ['B1', 'U3'] }] },
    users: {
      U1: person('U1', 'Ada'),
      U2: person('U2', 'Grace'),
      B1: person('B1', 'CHOIR', { is_bot: true }),
      U3: person('U3', 'Gone', { deleted: true }),
    },
  };

  it('pages the membership, flags bots and drops deleted accounts', async () => {
    const { client, calls } = fakeClient(options);

    const result = await channelMembers(client, 'C1', WS);
    expect(calls.members).toBe(2);
    expect(result.warning).toBeUndefined();
    expect(result.members).toEqual([
      { id: 'U1', name: 'Ada', title: "Ada's title", avatar: 'https://img/U1', isBot: false },
      { id: 'U2', name: 'Grace', title: "Grace's title", avatar: 'https://img/U2', isBot: false },
      { id: 'B1', name: 'CHOIR', title: "CHOIR's title", avatar: 'https://img/B1', isBot: true },
    ]);
  });

  it('serves the second read from the cache', async () => {
    const { client, calls } = fakeClient(options);

    await channelMembers(client, 'C1', WS);
    await channelMembers(client, 'C1', WS);
    expect(calls.members).toBe(2); // the two pages of the first read, and nothing more
    expect(calls.info).toBe(4);

    clearSlackDirectoryCache();
    await channelMembers(client, 'C1', WS);
    expect(calls.members).toBe(4);
  });

  it('answers an unreachable channel with a warning rather than an error', async () => {
    const { client } = fakeClient({ membersError: slackError('not_in_channel') });

    await expect(channelMembers(client, 'C9', WS)).resolves.toEqual({ members: [], warning: 'C9: not_in_channel' });
  });
});

describe('projectMembers', () => {
  function writeProject(folder: string, body: unknown): void {
    const dir = path.join(repoRoot, folder, '.choir');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(body));
  }

  it('unions the linked channels, drops bots and attaches the aliases', async () => {
    writeProject('alpha', {
      name: 'Alpha',
      channels: ['C1', 'C2'],
      members: { aliases: { U1: ['Ada L.'] } },
    });
    const { client } = fakeClient({
      memberPages: { C1: [{ members: ['U1', 'B1'] }], C2: [{ members: ['U1', 'U2'] }] },
      users: { U1: person('U1', 'Ada'), U2: person('U2', 'Grace'), B1: person('B1', 'CHOIR', { is_bot: true }) },
    });

    const result = await projectMembers(WS, 'alpha', client);
    expect(result.source).toBe('channels');
    expect(result.members.map((m) => [m.id, m.aliases])).toEqual([
      ['U1', ['Ada L.']],
      ['U2', []],
    ]);
  });

  it('reports a channel the bot has left without losing the other one', async () => {
    writeProject('alpha', { name: 'Alpha', channels: ['C1'] });
    const { client } = fakeClient({ membersError: slackError('channel_not_found') });

    const result = await projectMembers(WS, 'alpha', client);
    expect(result.members).toEqual([]);
    expect(result.warning).toBe('C1: channel_not_found');
  });

  it('reads only the curated list, without touching the channels', async () => {
    writeProject('alpha', {
      name: 'Alpha',
      channels: ['C1'],
      members: { source: 'curated', curated: ['U2'], aliases: { U2: ['Grace H.'] } },
    });
    const { client, calls } = fakeClient({ users: { U2: person('U2', 'Grace') } });

    const result = await projectMembers(WS, 'alpha', client);
    expect(result.source).toBe('curated');
    expect(result.members).toEqual([
      {
        id: 'U2',
        name: 'Grace',
        title: "Grace's title",
        avatar: 'https://img/U2',
        isBot: false,
        aliases: ['Grace H.'],
      },
    ]);
    expect(calls.members).toBe(0);
  });

  it('answers 404 for a folder that is not a project', async () => {
    const { client } = fakeClient({});
    const refusal = await projectMembers(WS, 'nowhere', client).catch((err) => err);
    expect(refusal).toBeInstanceOf(ProjectRefusal);
    expect(refusal.status).toBe(404);
    expect(refusal.apiCode).toBe('project_not_found');
  });
});
