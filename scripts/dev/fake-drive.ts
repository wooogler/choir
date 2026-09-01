/**
 * A file-backed stand-in for `services/google/drive-client`, so the Google Docs
 * replica loop can be driven end to end with no Google account, no GCP project
 * and no tunnel.
 *
 * Loaded as a Node preload (see `scripts/dev/fake-google.ts`), it replaces the
 * module's exports before anything calls them. That works because the compiled
 * modules call `drive_client_1.exportDocMarkdown(...)` at call time rather than
 * capturing the function at import time.
 *
 * What it does NOT reproduce: Google's export dialect. A real replica round trip
 * goes markdown → Docs → markdown and comes back subtly different (list markers,
 * escaping, trailing whitespace), which is exactly the class of bug the delta
 * extraction has to survive. Here, what is written is what is read back. A green
 * run against this fake proves the state machine, not the dialect.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from 'services/common/data-path';

if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
  throw new Error('scripts/dev/fake-drive is a development harness and must never load in production');
}

/**
 * The app decides whether Google sync exists at all from these two variables —
 * `AppConfig.getGoogleConfig().configured` gates the drift poller and the
 * viewer's Google panel. Nothing ever presents them to Google, because every
 * call that would is replaced below, but without them the loop is inert: the
 * poller never starts, so a simulated edit is never noticed. A value already
 * exported in the shell wins, but note that .env is read after this, and dotenv
 * does not override what is already set.
 */
process.env.GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || 'fake-google-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || 'fake-google-client-secret';

interface FakeDoc {
  fileId: string;
  name: string;
  /** What `files.export` would hand back — including the banner the publisher adds. */
  markdown: string;
  /** Drive's monotonic change counter. Bumped by every write, ours or a person's. */
  version: number;
  modifiedTime: string;
  lastModifyingUser?: string;
  trashed?: boolean;
  webViewLink: string;
  /** Set by the seed script so `pnpm gdocs:edit` can find a doc by its repo path. */
  workspaceId?: string;
  githubPath?: string;
}

interface FakeDriveStore {
  version: 1;
  docs: Record<string, FakeDoc>;
  nextId: number;
}

const STORE_PATH = getDataPath('fake-drive.json');

const EMPTY: FakeDriveStore = { version: 1, docs: {}, nextId: 1 };

export function readStore(): FakeDriveStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8')) as FakeDriveStore;
    return { version: 1, docs: parsed.docs ?? {}, nextId: parsed.nextId ?? 1 };
  } catch {
    return { ...EMPTY, docs: {} };
  }
}

export function writeStore(store: FakeDriveStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  // The app and the CLI scripts write this file from separate processes, so
  // swap it into place rather than leaving a half-written file readable.
  const temp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(temp, STORE_PATH);
}

/** Applies a change to one document and returns it, or throws if it is gone. */
export function mutateDoc(fileId: string, mutate: (doc: FakeDoc) => void): FakeDoc {
  const store = readStore();
  const doc = store.docs[fileId];
  if (!doc) {
    throw new Error(`Fake Drive: no such file ${fileId}`);
  }
  mutate(doc);
  writeStore(store);
  return doc;
}

export function getDoc(fileId: string): FakeDoc | undefined {
  return readStore().docs[fileId];
}

export function findDocByPath(workspaceId: string, githubPath: string): FakeDoc | undefined {
  return Object.values(readStore().docs).find(
    (doc) => doc.workspaceId === workspaceId && doc.githubPath === githubPath,
  );
}

/** Records which repo document a fake Doc stands in for, so the edit CLI can find it. */
export function tagDoc(fileId: string, workspaceId: string, githubPath: string): void {
  mutateDoc(fileId, (doc) => {
    doc.workspaceId = workspaceId;
    doc.githubPath = githubPath;
  });
}

function toMeta(doc: FakeDoc) {
  return {
    fileId: doc.fileId,
    name: doc.name,
    version: String(doc.version),
    modifiedTime: doc.modifiedTime,
    lastModifyingUser: doc.lastModifyingUser,
    trashed: doc.trashed,
    webViewLink: doc.webViewLink,
  };
}

/** The account our own writes are attributed to, mirroring the workspace token. */
const APP_ACCOUNT = 'choir-dev-workspace@example.com';

function install(): void {
  // Assigning onto the live exports object is the whole trick, and `require`
  // is what gives a mutable handle on it — a namespace import is read-only.
  const driveClient = require('services/google/drive-client') as Record<string, unknown>;

  driveClient.createDocFromMarkdown = async (
    _auth: unknown,
    params: { name: string; markdown: string; parentFolderId?: string },
  ) => {
    const store = readStore();
    const fileId = `fake-doc-${store.nextId}`;
    store.nextId += 1;
    store.docs[fileId] = {
      fileId,
      name: params.name,
      markdown: params.markdown,
      version: 1,
      modifiedTime: new Date().toISOString(),
      lastModifyingUser: APP_ACCOUNT,
      webViewLink: `http://localhost/fake-drive/${fileId}`,
    };
    writeStore(store);
    return toMeta(store.docs[fileId]);
  };

  driveClient.replaceDocContent = async (_auth: unknown, fileId: string, markdown: string) => {
    const doc = mutateDoc(fileId, (current) => {
      current.markdown = markdown;
      current.version += 1;
      current.modifiedTime = new Date().toISOString();
      current.lastModifyingUser = APP_ACCOUNT;
    });
    return toMeta(doc);
  };

  driveClient.exportDocMarkdown = async (_auth: unknown, fileId: string) => {
    const doc = getDoc(fileId);
    if (!doc) throw new Error(`Fake Drive: no such file ${fileId}`);
    return doc.markdown;
  };

  driveClient.getDocMeta = async (_auth: unknown, fileId: string) => {
    const doc = getDoc(fileId);
    if (!doc) throw new Error(`Fake Drive: no such file ${fileId}`);
    return toMeta(doc);
  };

  driveClient.createFolder = async (_auth: unknown, _name: string, _parentFolderId?: string) => 'fake-folder';

  // Every Drive call goes through this first. Returning a sentinel keeps
  // GOOGLE_OAUTH_CLIENT_ID and DOCS_BASE_URL out of the picture entirely —
  // `getRedirectUri()` throws without them, and it sits on the path of every
  // Drive call, not just the consent screen.
  const authService = require('services/google/google-auth-service') as Record<string, unknown>;
  const { WorkspaceStore } = require('services/workspace/workspace-store') as {
    WorkspaceStore: new () => { getGoogleAuth(workspaceId: string): Promise<unknown> };
  };

  authService.getWorkspaceClient = async (workspaceId: string) => {
    // Still gated on a stored credential, so "disconnect" behaves as it does in
    // production rather than silently staying connected.
    const auth = await new WorkspaceStore().getGoogleAuth(workspaceId);
    return auth ? ({ fake: true } as unknown) : null;
  };
}

install();
