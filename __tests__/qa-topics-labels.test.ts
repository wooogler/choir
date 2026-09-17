/**
 * The `qa_topics.labels_json` column: it is added idempotently on every database
 * open (including one created before the column existed), and localized labels
 * round-trip through the store.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getTopics, insertTopic, setTopicLabels, updateTopic } from 'services/dashboard/qa-event-store';
import { closeDatabase, getDatabase } from 'services/db/connection';

const WS = 'T-labels';

/** The qa_topics DDL as it shipped before localized labels — no labels_json. */
const OLD_DDL = `
  CREATE TABLE IF NOT EXISTS qa_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    label TEXT NOT NULL,
    representative TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

const columnNames = (): string[] =>
  (getDatabase().prepare('PRAGMA table_info(qa_topics)').all() as Array<{ name: string }>).map((c) => c.name);

describe('qa_topics localized labels', () => {
  let tempDir: string;
  let dbFile: string;

  beforeEach(() => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-labels-'));
    dbFile = path.join(tempDir, 'choir.db');
    process.env.DATABASE_URL = `file:${dbFile}`;
  });
  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  });

  it('creates labels_json on a fresh database', () => {
    expect(columnNames()).toContain('labels_json');
  });

  it('adds labels_json to a database created from the pre-localization DDL, keeping its rows', () => {
    const legacy = new Database(dbFile);
    legacy.exec(OLD_DDL);
    legacy
      .prepare('INSERT INTO qa_topics (workspace_id, label, representative, updated_at) VALUES (?, ?, ?, ?)')
      .run(WS, 'Travel funding', 'Is travel funding available?', 1);
    expect(
      (legacy.prepare('PRAGMA table_info(qa_topics)').all() as Array<{ name: string }>).map((c) => c.name),
    ).not.toContain('labels_json');
    legacy.close();

    expect(columnNames()).toContain('labels_json');
    const topics = getTopics(WS);
    expect(topics).toHaveLength(1);
    expect(topics[0].label).toBe('Travel funding');
    expect(topics[0].labels).toEqual({}); // pre-existing rows start untranslated
  });

  it('is idempotent across repeated opens (no duplicate-column error)', () => {
    const id = insertTopic(WS, 'Reimbursement', 'How do I get reimbursed?', 1);
    setTopicLabels(id, { ko: { label: '비용 정산', representative: '비용을 어떻게 정산하나요?' } });
    closeDatabase();
    expect(columnNames()).toContain('labels_json');
    expect(getTopics(WS)[0].labels.ko?.label).toBe('비용 정산');
  });

  it('round-trips labels through setTopicLabels and updateTopic', () => {
    const id = insertTopic(WS, 'Travel funding', 'Is travel funding available?', 1);
    expect(getTopics(WS)[0].labels).toEqual({});

    setTopicLabels(id, { ko: { label: '출장 지원금', representative: '출장 지원금을 받을 수 있나요?' } });
    expect(getTopics(WS)[0].labels).toEqual({
      ko: { label: '출장 지원금', representative: '출장 지원금을 받을 수 있나요?' },
    });

    // Updating without labels leaves the stored translations alone …
    updateTopic(id, 'Travel funding', 'Is travel funding available?', 2);
    expect(getTopics(WS)[0].labels.ko?.label).toBe('출장 지원금');

    // … and passing labels rewrites them in the same statement.
    updateTopic(id, 'Conference travel', 'Who pays for conference travel?', 3, {
      ko: { label: '학회 출장', representative: '학회 출장비는 누가 내나요?' },
    });
    const updated = getTopics(WS)[0];
    expect(updated.label).toBe('Conference travel');
    expect(updated.labels.ko?.label).toBe('학회 출장');

    setTopicLabels(id, {});
    expect(getTopics(WS)[0].labels).toEqual({});
  });

  it('ignores malformed or unsupported label JSON rather than throwing', () => {
    const id = insertTopic(WS, 'Travel funding', 'Is travel funding available?', 1);
    const db = getDatabase();
    const setRaw = (raw: string) => db.prepare('UPDATE qa_topics SET labels_json = ? WHERE id = ?').run(raw, id);

    setRaw('{not json');
    expect(getTopics(WS)[0].labels).toEqual({});

    // An unsupported locale, English (which never belongs in this column) and a
    // half-formed entry are all dropped, leaving nothing.
    setRaw(
      JSON.stringify({
        fr: { label: 'Frais de voyage', representative: 'Q?' },
        en: { label: 'Should be ignored', representative: 'Q?' },
        ko: { label: '출장 지원금' },
      }),
    );
    expect(getTopics(WS)[0].labels).toEqual({});
  });
});
