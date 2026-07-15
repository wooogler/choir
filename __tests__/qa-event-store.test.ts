import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countQaEvents, getQaEvents, insertQaEvent, purgeWorkspaceQaEvents } from 'services/dashboard/qa-event-store';
import { closeDatabase, getDatabase } from 'services/db/connection';

const WS = 'T-dash';

function baseEvent(overrides: Partial<Parameters<typeof insertQaEvent>[0]> = {}) {
  return {
    workspaceId: WS,
    createdAt: Date.now(),
    isoWeek: '2026-W29',
    channelType: 'dm' as const,
    canAnswer: true,
    searchResults: 3,
    userHash: 'hash-abc',
    paraphrase: 'Is travel funding available for second authors?',
    chunks: [
      { fileName: '06_Conferences.md', sectionId: 's1', headingPath: 'Funding > Travel' },
      { fileName: 'FAQ.md' },
    ],
    ...overrides,
  };
}

describe('qa-event-store', () => {
  let tempDir: string;

  beforeEach(() => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-qa-store-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  });

  it('inserts an event with its chunks and reads it back', () => {
    const id = insertQaEvent(baseEvent());
    expect(id).toBeGreaterThan(0);

    const events = getQaEvents(WS);
    expect(events).toHaveLength(1);
    expect(events[0].paraphrase).toMatch(/second authors/);
    expect(events[0].canAnswer).toBe(true); // 1 -> boolean
    expect(events[0].userHash).toBe('hash-abc');
    expect(events[0].isoWeek).toBe('2026-W29');

    const chunkCount = getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM qa_event_chunks WHERE event_id = ?')
      .get(id) as { n: number };
    expect(chunkCount.n).toBe(2);
  });

  it('stores can_answer as 0/1 and round-trips false', () => {
    insertQaEvent(baseEvent({ canAnswer: false }));
    expect(getQaEvents(WS)[0].canAnswer).toBe(false);
  });

  it("stores each chunk's file/section/heading values (optional columns null when absent)", () => {
    const id = insertQaEvent(baseEvent());
    const chunks = getDatabase()
      .prepare(
        'SELECT file_name AS fileName, section_id AS sectionId, heading_path AS headingPath FROM qa_event_chunks WHERE event_id = ? ORDER BY id',
      )
      .all(id);
    expect(chunks).toEqual([
      { fileName: '06_Conferences.md', sectionId: 's1', headingPath: 'Funding > Travel' },
      { fileName: 'FAQ.md', sectionId: null, headingPath: null },
    ]);
  });

  it('accepts an event with no chunks', () => {
    const id = insertQaEvent(baseEvent({ chunks: [] }));
    const n = getDatabase().prepare('SELECT COUNT(*) AS n FROM qa_event_chunks WHERE event_id = ?').get(id) as {
      n: number;
    };
    expect(n.n).toBe(0);
    expect(getQaEvents(WS)).toHaveLength(1);
  });

  it('scopes counts and reads by workspace', () => {
    insertQaEvent(baseEvent());
    insertQaEvent(baseEvent({ workspaceId: 'T-other' }));
    expect(countQaEvents(WS)).toBe(1);
    expect(countQaEvents('T-other')).toBe(1);
  });

  it('purges a workspace and cascades chunk deletion', () => {
    const id = insertQaEvent(baseEvent());
    insertQaEvent(baseEvent({ workspaceId: 'T-other' }));

    const removed = purgeWorkspaceQaEvents(WS);
    expect(removed).toBe(1);
    expect(countQaEvents(WS)).toBe(0);
    expect(countQaEvents('T-other')).toBe(1); // other workspace untouched

    const orphanChunks = getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM qa_event_chunks WHERE event_id = ?')
      .get(id) as { n: number };
    expect(orphanChunks.n).toBe(0); // FK ON DELETE CASCADE
  });

  it('purge also clears qa_topics for the workspace, leaving other workspaces intact', () => {
    const insertTopic = getDatabase().prepare(
      'INSERT INTO qa_topics (workspace_id, label, representative, updated_at) VALUES (?, ?, ?, ?)',
    );
    insertTopic.run(WS, 'travel funding', 'Is travel funding available?', 1);
    insertTopic.run('T-other', 'other', 'Other topic?', 1);

    purgeWorkspaceQaEvents(WS);

    const topicCount = (ws: string) =>
      (getDatabase().prepare('SELECT COUNT(*) AS n FROM qa_topics WHERE workspace_id = ?').get(ws) as { n: number }).n;
    expect(topicCount(WS)).toBe(0);
    expect(topicCount('T-other')).toBe(1);
  });
});
