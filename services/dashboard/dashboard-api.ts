/**
 * Read/aggregation layer for the awareness dashboard API. Every response is
 * bucketed to ISO week (never a finer time) and enforces k-anonymity: a topic is
 * only exposed individually when at least K_MIN_DISTINCT_USERS distinct users
 * asked into it within the window; anything below that (and any not-yet-clustered
 * events) folds into an "Other" bucket. k-anonymity is enforced HERE, server-side
 * — never rely on the client to filter.
 */
import { getDatabase } from 'services/db/connection';
import { getTopics as getTopicRows } from './qa-event-store';

export const K_MIN_DISTINCT_USERS = 2;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function cutoffFor(weeks: number, now: number): number {
  return now - Math.max(1, weeks) * WEEK_MS;
}

export interface WeekPoint {
  isoWeek: string;
  total: number;
  answered: number;
  answeredRatio: number;
}

export interface DashboardSummary {
  weeks: WeekPoint[];
  totals: { questions: number; answered: number; answeredRatio: number; activeTopics: number };
}

export function getSummary(workspaceId: string, weeks = 12, now = Date.now()): DashboardSummary {
  const db = getDatabase();
  const cutoff = cutoffFor(weeks, now);

  const rows = db
    .prepare(
      `SELECT iso_week AS isoWeek, COUNT(*) AS total, SUM(can_answer) AS answered
       FROM qa_events WHERE workspace_id = ? AND created_at >= ?
       GROUP BY iso_week ORDER BY iso_week`,
    )
    .all(workspaceId, cutoff) as Array<{ isoWeek: string; total: number; answered: number }>;

  const activeTopics = (
    db
      .prepare(
        'SELECT COUNT(DISTINCT topic_id) AS n FROM qa_events WHERE workspace_id = ? AND created_at >= ? AND topic_id IS NOT NULL',
      )
      .get(workspaceId, cutoff) as { n: number }
  ).n;

  const questions = rows.reduce((s, r) => s + r.total, 0);
  const answered = rows.reduce((s, r) => s + r.answered, 0);

  return {
    weeks: rows.map((r) => ({
      isoWeek: r.isoWeek,
      total: r.total,
      answered: r.answered,
      answeredRatio: ratio(r.answered, r.total),
    })),
    totals: { questions, answered, answeredRatio: ratio(answered, questions), activeTopics },
  };
}

interface TopicAggRow {
  topicId: number | null;
  total: number;
  answered: number;
  users: number;
}

function topicAggregate(db: ReturnType<typeof getDatabase>, workspaceId: string, cutoff: number): TopicAggRow[] {
  return db
    .prepare(
      `SELECT topic_id AS topicId, COUNT(*) AS total, SUM(can_answer) AS answered, COUNT(DISTINCT user_hash) AS users
       FROM qa_events WHERE workspace_id = ? AND created_at >= ?
       GROUP BY topic_id`,
    )
    .all(workspaceId, cutoff) as TopicAggRow[];
}

export interface TopicView {
  topicId: number;
  label: string;
  representative: string;
  total: number;
  answered: number;
  answeredRatio: number;
  weeklyCounts: Record<string, number>;
}

export interface TopicsResponse {
  topics: TopicView[];
  other: { count: number };
}

export function getTopics(workspaceId: string, weeks = 12, now = Date.now()): TopicsResponse {
  const db = getDatabase();
  const cutoff = cutoffFor(weeks, now);
  const agg = topicAggregate(db, workspaceId, cutoff);
  const meta = new Map(getTopicRows(workspaceId).map((t) => [t.id, t]));

  const weeklyRows = db
    .prepare(
      `SELECT topic_id AS topicId, iso_week AS isoWeek, COUNT(*) AS n
       FROM qa_events WHERE workspace_id = ? AND created_at >= ? AND topic_id IS NOT NULL
       GROUP BY topic_id, iso_week`,
    )
    .all(workspaceId, cutoff) as Array<{ topicId: number; isoWeek: string; n: number }>;
  const weeklyByTopic = new Map<number, Record<string, number>>();
  for (const w of weeklyRows) {
    if (!weeklyByTopic.has(w.topicId)) weeklyByTopic.set(w.topicId, {});
    (weeklyByTopic.get(w.topicId) as Record<string, number>)[w.isoWeek] = w.n;
  }

  const topics: TopicView[] = [];
  let otherCount = 0;
  for (const row of agg) {
    const topicMeta = row.topicId != null ? meta.get(row.topicId) : undefined;
    // k-anonymity: hide topics asked by fewer than K distinct users, and fold in
    // unclustered (topic_id NULL) events too.
    if (row.topicId == null || !topicMeta || row.users < K_MIN_DISTINCT_USERS) {
      otherCount += row.total;
      continue;
    }
    topics.push({
      topicId: row.topicId,
      label: topicMeta.label,
      representative: topicMeta.representative,
      total: row.total,
      answered: row.answered,
      answeredRatio: ratio(row.answered, row.total),
      weeklyCounts: weeklyByTopic.get(row.topicId) ?? {},
    });
  }
  topics.sort((a, b) => b.total - a.total);
  return { topics, other: { count: otherCount } };
}

export interface GapView {
  topicId: number;
  label: string;
  representative: string;
  total: number;
  unanswered: number;
  answeredRatio: number;
  relatedDocs: Array<{ fileName: string; headingPath: string | null; count: number }>;
}

export interface GapsResponse {
  gaps: GapView[];
  other: { unanswered: number };
}

export function getGaps(workspaceId: string, weeks = 12, now = Date.now()): GapsResponse {
  const db = getDatabase();
  const cutoff = cutoffFor(weeks, now);
  const agg = topicAggregate(db, workspaceId, cutoff);
  const meta = new Map(getTopicRows(workspaceId).map((t) => [t.id, t]));

  // Docs retrieved when the answer failed (retrieved-but-insufficient), per topic.
  const docRows = db
    .prepare(
      `SELECT e.topic_id AS topicId, c.file_name AS fileName, c.heading_path AS headingPath, COUNT(*) AS count
       FROM qa_events e JOIN qa_event_chunks c ON c.event_id = e.id
       WHERE e.workspace_id = ? AND e.created_at >= ? AND e.can_answer = 0 AND e.topic_id IS NOT NULL
       GROUP BY e.topic_id, c.file_name, c.heading_path`,
    )
    .all(workspaceId, cutoff) as Array<{
    topicId: number;
    fileName: string;
    headingPath: string | null;
    count: number;
  }>;
  const docsByTopic = new Map<number, GapView['relatedDocs']>();
  for (const d of docRows) {
    if (!docsByTopic.has(d.topicId)) docsByTopic.set(d.topicId, []);
    docsByTopic.get(d.topicId)?.push({ fileName: d.fileName, headingPath: d.headingPath, count: d.count });
  }

  const gaps: GapView[] = [];
  let otherUnanswered = 0;
  for (const row of agg) {
    const unanswered = row.total - row.answered;
    if (unanswered === 0) continue;
    const topicMeta = row.topicId != null ? meta.get(row.topicId) : undefined;
    if (row.topicId == null || !topicMeta || row.users < K_MIN_DISTINCT_USERS) {
      otherUnanswered += unanswered;
      continue;
    }
    gaps.push({
      topicId: row.topicId,
      label: topicMeta.label,
      representative: topicMeta.representative,
      total: row.total,
      unanswered,
      answeredRatio: ratio(row.answered, row.total),
      relatedDocs: (docsByTopic.get(row.topicId) ?? []).sort((a, b) => b.count - a.count).slice(0, 5),
    });
  }
  gaps.sort((a, b) => b.unanswered - a.unanswered);
  return { gaps, other: { unanswered: otherUnanswered } };
}

export interface DocUsageFile {
  fileName: string;
  retrievals: number;
  unanswered: number;
  lastWeek: string;
}

export interface DocUsageSection {
  sectionId: string | null;
  headingPath: string | null;
  retrievals: number;
  unanswered: number;
}

/**
 * Document usage. Without `file`: per-file retrieval counts (which docs are
 * load-bearing in Q&A). With `file`: per-section detail for that file (drives the
 * in-doc highlight in P2). This is document-level aggregation, not user-level, so
 * no k-anonymity applies.
 */
export function getDocUsage(
  workspaceId: string,
  weeks = 12,
  now = Date.now(),
  file?: string,
): { files: DocUsageFile[] } | { file: string; sections: DocUsageSection[] } {
  const db = getDatabase();
  const cutoff = cutoffFor(weeks, now);

  if (file) {
    const sections = db
      .prepare(
        `SELECT c.section_id AS sectionId, c.heading_path AS headingPath, COUNT(*) AS retrievals,
                SUM(CASE WHEN e.can_answer = 0 THEN 1 ELSE 0 END) AS unanswered
         FROM qa_event_chunks c JOIN qa_events e ON c.event_id = e.id
         WHERE e.workspace_id = ? AND e.created_at >= ? AND c.file_name = ?
         GROUP BY c.section_id, c.heading_path ORDER BY retrievals DESC`,
      )
      .all(workspaceId, cutoff, file) as DocUsageSection[];
    return { file, sections };
  }

  const files = db
    .prepare(
      `SELECT c.file_name AS fileName, COUNT(*) AS retrievals, MAX(e.iso_week) AS lastWeek,
              SUM(CASE WHEN e.can_answer = 0 THEN 1 ELSE 0 END) AS unanswered
       FROM qa_event_chunks c JOIN qa_events e ON c.event_id = e.id
       WHERE e.workspace_id = ? AND e.created_at >= ?
       GROUP BY c.file_name ORDER BY retrievals DESC`,
    )
    .all(workspaceId, cutoff) as DocUsageFile[];
  return { files };
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}
