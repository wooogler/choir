import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionType, getSessionData, storeSessionData, sweepExpiredSessions } from 'services/common/session-store';
import { closeDatabase, getDatabase } from 'services/db/connection';

describe('sweepExpiredSessions', () => {
  let tempDir: string;

  beforeEach(() => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-session-sweep-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('deletes expired rows and keeps live ones', () => {
    storeSessionData('s-expired', { workspaceId: 'T1' }, SessionType.GENERAL_CONVERSATION, 60_000);
    storeSessionData('s-live', { workspaceId: 'T1' }, SessionType.GENERAL_CONVERSATION, 60_000);

    // Force the first row's TTL into the past (deterministic, no real waiting).
    getDatabase()
      .prepare('UPDATE sessions SET expires_at = ? WHERE session_id = ?')
      .run(Date.now() - 1000, 's-expired');

    const removed = sweepExpiredSessions();
    expect(removed).toBe(1);

    expect(getSessionData('s-expired', SessionType.GENERAL_CONVERSATION)).toBeNull();
    expect(getSessionData('s-live', SessionType.GENERAL_CONVERSATION)).not.toBeNull();
  });

  it('returns 0 when nothing is expired', () => {
    storeSessionData('s1', { workspaceId: 'T1' }, SessionType.DOCUMENT_UPDATE, 60_000);
    expect(sweepExpiredSessions()).toBe(0);
  });
});
