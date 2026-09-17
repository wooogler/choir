/**
 * Data access for the awareness-dashboard Q&A analytics tables. Stores only
 * privacy-scrubbed rows: a paraphrased question (never the raw text), a salted
 * user hash (never a raw userId), and a week label. See services/db/connection.ts
 * for the schema.
 */
import { getDatabase } from 'services/db/connection';
import { type Locale, isSupportedLocale } from '../../src/i18n/supported-locales';

export interface QaEventChunkInput {
  fileName: string;
  sectionId?: string;
  headingPath?: string;
}

export interface QaEventInput {
  workspaceId: string;
  createdAt: number;
  isoWeek: string;
  channelType: 'dm' | 'public' | 'private';
  canAnswer: boolean;
  searchResults: number;
  userHash: string;
  paraphrase: string;
  /** Paraphrase embedding, filled later by the P1 clustering job; omit at record time. */
  embedding?: Float32Array;
  chunks: QaEventChunkInput[];
}

// better-sqlite3 binds a Node Buffer for a BLOB. Use the view-safe form so a
// subarray's offset/length is honored (Buffer.from(f32) would byte-truncate).
const encodeEmbedding = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

// Rebuild a fresh, aligned Float32Array — a pooled Buffer may be at a non-4-aligned
// offset, so slicing into a new ArrayBuffer is the only always-safe reconstruction.
const decodeEmbedding = (b: Buffer): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/**
 * Inserts a Q&A event and its retrieved-chunk rows atomically. Returns the new
 * event id. The callback is fully synchronous, as better-sqlite3 transactions
 * require — do all async work (paraphrase, embed) before calling this.
 */
export function insertQaEvent(input: QaEventInput): number {
  const db = getDatabase();

  const insertEvent = db.prepare(`
    INSERT INTO qa_events
      (workspace_id, created_at, iso_week, channel_type, can_answer, search_results, user_hash, paraphrase, embedding)
    VALUES
      (@workspaceId, @createdAt, @isoWeek, @channelType, @canAnswer, @searchResults, @userHash, @paraphrase, @embedding)
  `);
  const insertChunk = db.prepare(`
    INSERT INTO qa_event_chunks (event_id, file_name, section_id, heading_path)
    VALUES (@eventId, @fileName, @sectionId, @headingPath)
  `);

  const run = db.transaction((): number => {
    const res = insertEvent.run({
      workspaceId: input.workspaceId,
      createdAt: input.createdAt,
      isoWeek: input.isoWeek,
      channelType: input.channelType,
      canAnswer: input.canAnswer ? 1 : 0,
      searchResults: input.searchResults,
      userHash: input.userHash,
      paraphrase: input.paraphrase,
      embedding: input.embedding ? encodeEmbedding(input.embedding) : null,
    });
    const eventId = Number(res.lastInsertRowid);

    for (const chunk of input.chunks) {
      insertChunk.run({
        eventId,
        fileName: chunk.fileName,
        sectionId: chunk.sectionId ?? null,
        headingPath: chunk.headingPath ?? null,
      });
    }
    return eventId;
  });

  return run();
}

export interface QaEventRow {
  id: number;
  workspaceId: string;
  createdAt: number;
  isoWeek: string;
  channelType: string;
  canAnswer: boolean;
  searchResults: number;
  userHash: string;
  paraphrase: string;
  topicId: number | null;
}

/** Recent events for a workspace (newest first) — used by the P1 clusterer/API. */
export function getQaEvents(workspaceId: string, limit = 500): QaEventRow[] {
  const rows = getDatabase()
    .prepare(`
      SELECT id, workspace_id AS workspaceId, created_at AS createdAt, iso_week AS isoWeek,
             channel_type AS channelType, can_answer AS canAnswer, search_results AS searchResults,
             user_hash AS userHash, paraphrase, topic_id AS topicId
      FROM qa_events
      WHERE workspace_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(workspaceId, limit) as Array<Omit<QaEventRow, 'canAnswer'> & { canAnswer: number }>;
  return rows.map((r) => ({ ...r, canAnswer: r.canAnswer === 1 }));
}

export function countQaEvents(workspaceId: string): number {
  const row = getDatabase().prepare('SELECT COUNT(*) AS n FROM qa_events WHERE workspace_id = ?').get(workspaceId) as {
    n: number;
  };
  return row.n;
}

/** Removes all dashboard rows for a workspace (chunks cascade via FK). Used on uninstall. */
export function purgeWorkspaceQaEvents(workspaceId: string): number {
  const db = getDatabase();
  const removed = db.prepare('DELETE FROM qa_events WHERE workspace_id = ?').run(workspaceId).changes;
  db.prepare('DELETE FROM qa_topics WHERE workspace_id = ?').run(workspaceId);
  return removed;
}

// ── Clustering support (P1) ─────────────────────────────────────────────────

export interface UnembeddedEvent {
  id: number;
  paraphrase: string;
}

/** Events whose paraphrase has not been embedded yet (the clusterer embeds these). */
export function getEventsNeedingEmbedding(workspaceId: string, limit = 500): UnembeddedEvent[] {
  return getDatabase()
    .prepare(
      'SELECT id, paraphrase FROM qa_events WHERE workspace_id = ? AND embedding IS NULL ORDER BY created_at ASC LIMIT ?',
    )
    .all(workspaceId, limit) as UnembeddedEvent[];
}

export function setEventEmbedding(eventId: number, embedding: Float32Array): void {
  getDatabase().prepare('UPDATE qa_events SET embedding = ? WHERE id = ?').run(encodeEmbedding(embedding), eventId);
}

export interface EmbeddedEvent {
  id: number;
  paraphrase: string;
  embedding: Float32Array;
  topicId: number | null;
}

/** All embedded events for a workspace, for the clusterer to (re)assign topics. */
export function getEmbeddedEvents(workspaceId: string): EmbeddedEvent[] {
  const rows = getDatabase()
    .prepare(
      'SELECT id, paraphrase, embedding, topic_id AS topicId FROM qa_events WHERE workspace_id = ? AND embedding IS NOT NULL ORDER BY created_at ASC',
    )
    .all(workspaceId) as Array<{ id: number; paraphrase: string; embedding: Buffer; topicId: number | null }>;
  return rows.map((r) => ({ ...r, embedding: decodeEmbedding(r.embedding) }));
}

export function setEventTopic(eventId: number, topicId: number): void {
  getDatabase().prepare('UPDATE qa_events SET topic_id = ? WHERE id = ?').run(topicId, eventId);
}

/** One topic's label + representative question in a single language. */
export interface LocalizedLabel {
  label: string;
  representative: string;
}

/**
 * Translations of a topic's English label, keyed by locale. English is never a
 * key here — it lives in the `label`/`representative` columns, which stay the
 * clustering key. A locale that is missing (translation failed, or was added
 * after this topic was last labeled) simply falls back to English.
 */
export type TopicLabels = Partial<Record<Locale, LocalizedLabel>>;

export interface TopicRow {
  id: number;
  label: string;
  representative: string;
  labels: TopicLabels;
}

/** Tolerates NULL, malformed JSON and unexpected shapes — labels are decoration. */
function decodeLabels(raw: string | null): TopicLabels {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: TopicLabels = {};
  for (const [locale, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isSupportedLocale(locale) || locale === 'en') continue;
    const entry = value as Partial<LocalizedLabel> | null;
    if (!entry || typeof entry.label !== 'string' || typeof entry.representative !== 'string') continue;
    if (!entry.label.trim() || !entry.representative.trim()) continue;
    out[locale] = { label: entry.label, representative: entry.representative };
  }
  return out;
}

const encodeLabels = (labels: TopicLabels): string | null =>
  Object.keys(labels).length > 0 ? JSON.stringify(labels) : null;

export function insertTopic(workspaceId: string, label: string, representative: string, updatedAt: number): number {
  const res = getDatabase()
    .prepare('INSERT INTO qa_topics (workspace_id, label, representative, updated_at) VALUES (?, ?, ?, ?)')
    .run(workspaceId, label, representative, updatedAt);
  return Number(res.lastInsertRowid);
}

/**
 * Updates a topic's English label. Pass `labels` to rewrite the localized
 * display labels in the same statement (so a changed English label never sits
 * next to a stale translation); omit it to leave them untouched.
 */
export function updateTopic(
  id: number,
  label: string,
  representative: string,
  updatedAt: number,
  labels?: TopicLabels,
): void {
  const db = getDatabase();
  if (labels === undefined) {
    db.prepare('UPDATE qa_topics SET label = ?, representative = ?, updated_at = ? WHERE id = ?').run(
      label,
      representative,
      updatedAt,
      id,
    );
    return;
  }
  db.prepare('UPDATE qa_topics SET label = ?, representative = ?, labels_json = ?, updated_at = ? WHERE id = ?').run(
    label,
    representative,
    encodeLabels(labels),
    updatedAt,
    id,
  );
}

/** Replaces only the localized labels (used by the backfill script). */
export function setTopicLabels(id: number, labels: TopicLabels): void {
  getDatabase().prepare('UPDATE qa_topics SET labels_json = ? WHERE id = ?').run(encodeLabels(labels), id);
}

export function getTopics(workspaceId: string): TopicRow[] {
  const rows = getDatabase()
    .prepare(
      'SELECT id, label, representative, labels_json AS labelsJson FROM qa_topics WHERE workspace_id = ? ORDER BY id',
    )
    .all(workspaceId) as Array<Omit<TopicRow, 'labels'> & { labelsJson: string | null }>;
  return rows.map(({ labelsJson, ...topic }) => ({ ...topic, labels: decodeLabels(labelsJson) }));
}
