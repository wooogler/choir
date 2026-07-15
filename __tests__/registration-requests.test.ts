import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearAllSessionTimers, purgeWorkspaceSessions } from 'services/common/session-store';
import { closeDatabase } from 'services/db/connection';
import {
  type RegistrationRequest,
  approveCHOIRUser,
  buildNonUserResponse,
  clearRegistrationRequest,
  clearWorkspaceIdCache,
  getRegistrationRequest,
  saveRegistrationRequest,
} from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { declineChoirRegistrationAction } from '../listeners/features/registration/decline-registration-action';
import { handleNonUserAccess } from '../listeners/features/registration/non-user-access';

const WORKSPACE = 'T1';
const USER = 'U-newbie';

function makeOffered(overrides: Partial<RegistrationRequest> = {}): RegistrationRequest {
  const now = Date.now();
  return {
    workspaceId: WORKSPACE,
    userId: USER,
    userName: 'New Bie',
    status: 'offered',
    heldQuestion: 'How do I request travel funding?',
    origin: { channelId: 'D123', isPublic: false },
    managerMessageInfo: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeClient() {
  return {
    token: 'xoxb-test',
    auth: { test: async () => ({ team_id: WORKSPACE, user_id: 'B1' }) },
    users: {
      info: async () => ({
        user: { id: USER, name: 'newbie', real_name: 'New Bie', is_bot: false, is_owner: false, profile: {} },
      }),
    },
    chat: {
      postMessage: jest.fn(async () => ({ ok: true, ts: '1.1', channel: 'D1' })),
      postEphemeral: jest.fn(async () => ({ ok: true })),
      update: jest.fn(async () => ({ ok: true })),
    },
    conversations: { open: jest.fn(async () => ({ channel: { id: 'D-target' } })) },
  };
}

const silentLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

function withTempDb() {
  let tempDir: string;
  beforeEach(() => {
    closeDatabase();
    clearWorkspaceIdCache();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-registration-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
    process.env.CHOIR_DATA_DIR = tempDir;
  });
  afterEach(() => {
    clearAllSessionTimers();
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    Reflect.deleteProperty(process.env, 'CHOIR_DB_KEY_FILE');
    Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
  });
}

describe('registration request store', () => {
  withTempDb();

  it('round-trips an offered request', () => {
    saveRegistrationRequest(makeOffered());
    const loaded = getRegistrationRequest(WORKSPACE, USER);
    expect(loaded?.status).toBe('offered');
    expect(loaded?.heldQuestion).toBe('How do I request travel funding?');
    expect(loaded?.origin.isPublic).toBe(false);
  });

  it('overwrites on save (offered -> pending) keyed by workspace+user', () => {
    saveRegistrationRequest(makeOffered());
    const req = getRegistrationRequest(WORKSPACE, USER) as RegistrationRequest;
    req.status = 'pending';
    req.managerMessageInfo = { 'U-mgr': { channel: 'D-mgr', ts: '111.222' } };
    saveRegistrationRequest(req);

    const loaded = getRegistrationRequest(WORKSPACE, USER);
    expect(loaded?.status).toBe('pending');
    expect(loaded?.managerMessageInfo['U-mgr']?.ts).toBe('111.222');
  });

  it('isolates requests by user within a workspace', () => {
    saveRegistrationRequest(makeOffered({ userId: 'U-a' }));
    saveRegistrationRequest(makeOffered({ userId: 'U-b', status: 'pending' }));
    expect(getRegistrationRequest(WORKSPACE, 'U-a')?.status).toBe('offered');
    expect(getRegistrationRequest(WORKSPACE, 'U-b')?.status).toBe('pending');
  });

  it('clearRegistrationRequest is an atomic claim: first caller wins, second is a no-op', () => {
    saveRegistrationRequest(makeOffered({ status: 'pending' }));
    expect(clearRegistrationRequest(WORKSPACE, USER)).toBe(true);
    expect(clearRegistrationRequest(WORKSPACE, USER)).toBe(false);
    expect(getRegistrationRequest(WORKSPACE, USER)).toBeNull();
  });

  it('is reaped by purgeWorkspaceSessions via its stored workspaceId', () => {
    saveRegistrationRequest(makeOffered());
    expect(purgeWorkspaceSessions(WORKSPACE)).toBeGreaterThan(0);
    expect(getRegistrationRequest(WORKSPACE, USER)).toBeNull();
  });

  it('survives past the moment a 32-bit-overflowing expiry timer would fire (30-day TTL)', async () => {
    // Regression: a >24.8-day TTL clamped setTimeout to 1ms, deleting the request
    // almost immediately in a live process. It must persist instead.
    saveRegistrationRequest(makeOffered());
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(getRegistrationRequest(WORKSPACE, USER)?.status).toBe('offered');
  });
});

describe('approveCHOIRUser', () => {
  withTempDb();

  const fakeClient = {
    token: 'xoxb-test',
    auth: { test: async () => ({ team_id: WORKSPACE, user_id: 'B1' }) },
    users: {
      info: async () => ({
        user: { id: USER, name: 'newbie', real_name: 'New Bie', is_bot: false, profile: { display_name: 'New Bie' } },
      }),
    },
  } as any;

  it('adds the requester to the workspace CHOIR user list', async () => {
    const store = new WorkspaceStore();
    await store.saveWorkspaceConfig({
      workspaceId: WORKSPACE,
      managers: ['U-mgr'],
      choirUsers: ['U-mgr'],
      organizationName: WORKSPACE,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    await approveCHOIRUser(WORKSPACE, USER, fakeClient);

    const config = await store.getWorkspaceConfig(WORKSPACE);
    expect(config?.choirUsers).toContain(USER);
  });
});

describe('buildNonUserResponse', () => {
  const blockId = 'choir_authorization_123';

  it('fresh: welcomes and tags the section for history exclusion', async () => {
    const { text, blocks } = await buildNonUserResponse('fresh', { authorizationBlockId: blockId });
    expect(text).toMatch(/not a CHOIR user yet/i);
    expect(blocks[0].block_id).toBe(blockId);
    // The Request Access button is appended by the caller, not by this builder.
    expect(blocks.some((b: any) => b.type === 'actions')).toBe(false);
  });

  it('fresh: includes a consent-form hint only when a URL is configured', async () => {
    const without = await buildNonUserResponse('fresh', { authorizationBlockId: blockId });
    const withUrl = await buildNonUserResponse('fresh', {
      authorizationBlockId: blockId,
      consentFormUrl: 'https://example.com/consent',
    });
    expect(withUrl.blocks.length).toBeGreaterThan(without.blocks.length);
    expect(JSON.stringify(withUrl.blocks)).toContain('https://example.com/consent');
  });

  it('pending and declined return distinct, button-less notices', async () => {
    const pending = await buildNonUserResponse('pending', { authorizationBlockId: blockId });
    const declined = await buildNonUserResponse('declined', { authorizationBlockId: blockId });
    expect(pending.text).toMatch(/waiting for manager approval/i);
    expect(declined.text).toMatch(/wasn't approved/i);
    expect(pending.text).not.toBe(declined.text);
    for (const r of [pending, declined]) {
      expect(r.blocks[0].block_id).toBe(blockId);
      expect(r.blocks.some((b: any) => b.type === 'actions')).toBe(false);
    }
  });
});

describe('handleNonUserAccess', () => {
  withTempDb();

  it('replies ephemerally for a channel @mention and never posts publicly', async () => {
    const client = makeClient();
    await handleNonUserAccess({
      client,
      event: { channel: 'C-public' },
      logger: silentLogger(),
      userId: USER,
      workspaceId: WORKSPACE,
      heldQuestion: 'Can I get travel funding?',
      isMention: true,
    });

    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    const call = client.chat.postEphemeral.mock.calls[0][0];
    expect(call.channel).toBe('C-public');
    expect(call.user).toBe(USER);

    const stored = getRegistrationRequest(WORKSPACE, USER);
    expect(stored?.status).toBe('offered');
    expect(stored?.origin.isPublic).toBe(true);
    expect(stored?.origin.channelId).toBe('C-public');
    expect(stored?.heldQuestion).toBe('Can I get travel funding?');
  });

  it('replies via normal message for a DM and records a non-public origin', async () => {
    const client = makeClient();
    await handleNonUserAccess({
      client,
      event: { channel: 'D-im' },
      logger: silentLogger(),
      userId: USER,
      workspaceId: WORKSPACE,
      heldQuestion: 'hi',
      isMention: false,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postEphemeral).not.toHaveBeenCalled();
    expect(getRegistrationRequest(WORKSPACE, USER)?.origin.isPublic).toBe(false);
  });

  it('shows the waiting notice for a pending request without overwriting it', async () => {
    saveRegistrationRequest(
      makeOffered({ status: 'pending', managerMessageInfo: { M1: { channel: 'D-M1', ts: '9.9' } } }),
    );
    const client = makeClient();
    await handleNonUserAccess({
      client,
      event: { channel: 'D-im' },
      logger: silentLogger(),
      userId: USER,
      workspaceId: WORKSPACE,
      heldQuestion: 'a different question',
      isMention: false,
    });

    const posted = client.chat.postMessage.mock.calls[0][0];
    expect(posted.text).toMatch(/waiting for manager approval/i);
    expect(JSON.stringify(posted.blocks)).not.toContain('request_choir_access');

    const stored = getRegistrationRequest(WORKSPACE, USER);
    expect(stored?.status).toBe('pending');
    expect(stored?.managerMessageInfo.M1?.ts).toBe('9.9'); // not clobbered
  });

  it('shows the declined notice (no Request Access button) for a declined request', async () => {
    saveRegistrationRequest(makeOffered({ status: 'declined', heldQuestion: undefined }));
    const client = makeClient();
    await handleNonUserAccess({
      client,
      event: { channel: 'D-im' },
      logger: silentLogger(),
      userId: USER,
      workspaceId: WORKSPACE,
      heldQuestion: 'retry',
      isMention: false,
    });

    const posted = client.chat.postMessage.mock.calls[0][0];
    expect(posted.text).toMatch(/wasn't approved/i);
    expect(JSON.stringify(posted.blocks)).not.toContain('request_choir_access');
    expect(getRegistrationRequest(WORKSPACE, USER)?.status).toBe('declined');
  });
});

describe('declineChoirRegistrationAction', () => {
  withTempDb();

  it('marks the request declined and discards the held question', async () => {
    const store = new WorkspaceStore();
    await store.saveWorkspaceConfig({
      workspaceId: WORKSPACE,
      managers: ['M1'],
      choirUsers: ['M1'],
      organizationName: WORKSPACE,
      loggingEnabled: false, // keep the test hermetic (no interaction-log file write)
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    saveRegistrationRequest(
      makeOffered({
        status: 'pending',
        heldQuestion: 'a private question',
        managerMessageInfo: { M1: { channel: 'D-M1', ts: '5.5' } },
      }),
    );

    const client = makeClient();
    const ack = jest.fn(async () => undefined);
    await declineChoirRegistrationAction({
      ack,
      body: { user: { id: 'M1' }, actions: [{ value: USER }] },
      client,
      logger: silentLogger(),
    } as any);

    expect(ack).toHaveBeenCalled();
    const stored = getRegistrationRequest(WORKSPACE, USER);
    expect(stored?.status).toBe('declined');
    expect(stored?.heldQuestion).toBeUndefined();
  });
});
