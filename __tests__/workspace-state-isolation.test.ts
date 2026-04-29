import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from 'services/db/connection';
import {
  type DocumentUpdate,
  getStoredDocumentUpdates,
  purgeWorkspaceAppState,
  storeDocumentUpdates,
} from 'services/document/document-store';
import { SessionType, getSessionData, purgeWorkspaceSessions, storeSessionData } from 'services/common/session-store';

const createDocumentUpdate = (fileName: string): DocumentUpdate => ({
  index: 0,
  fileName,
  githubUrl: `https://github.com/example/repo/blob/main/${fileName}`,
  markdownSection: 'Section',
  hasChanges: true,
  nodeContent: 'old',
  updatedNodeContent: 'new',
  diffBlock: {},
  nodeId: `${fileName}:node`,
  oldContent: 'old',
  newContent: 'new',
  messages: [],
  timestamp: '123',
  suggestionType: 'UPDATE',
});

describe('workspace state isolation', () => {
  let tempDir: string;

  beforeEach(() => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-state-test-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    Reflect.deleteProperty(process.env, 'CHOIR_DB_KEY_FILE');
  });

  it('scopes document update state by workspace and user', () => {
    const userId = 'U123';
    const workspaceAUpdate = createDocumentUpdate('a.md');
    const workspaceBUpdate = createDocumentUpdate('b.md');

    storeDocumentUpdates(userId, [workspaceAUpdate], undefined, undefined, 'TA');
    storeDocumentUpdates(userId, [workspaceBUpdate], undefined, undefined, 'TB');

    expect(getStoredDocumentUpdates(userId, 'TA')).toEqual([workspaceAUpdate]);
    expect(getStoredDocumentUpdates(userId, 'TB')).toEqual([workspaceBUpdate]);
  });

  it('purges app state and sessions for only the selected workspace', () => {
    const userId = 'U123';
    const workspaceAUpdate = createDocumentUpdate('a.md');
    const workspaceBUpdate = createDocumentUpdate('b.md');

    storeDocumentUpdates(userId, [workspaceAUpdate], undefined, undefined, 'TA');
    storeDocumentUpdates(userId, [workspaceBUpdate], undefined, undefined, 'TB');
    storeSessionData(
      'session-a',
      { workspaceId: 'TA', value: 'remove-me' },
      SessionType.DOCUMENT_UPDATE,
    );
    storeSessionData(
      'session-b',
      { workspaceId: 'TB', value: 'keep-me' },
      SessionType.DOCUMENT_UPDATE,
    );

    expect(purgeWorkspaceAppState('TA')).toBe(1);
    expect(purgeWorkspaceSessions('TA')).toBe(1);

    expect(getStoredDocumentUpdates(userId, 'TA')).toEqual([]);
    expect(getStoredDocumentUpdates(userId, 'TB')).toEqual([workspaceBUpdate]);
    expect(getSessionData('session-a', SessionType.DOCUMENT_UPDATE)).toBeNull();
    expect(getSessionData('session-b', SessionType.DOCUMENT_UPDATE)).toEqual({
      workspaceId: 'TB',
      value: 'keep-me',
    });

    purgeWorkspaceSessions('TB');
  });
});
