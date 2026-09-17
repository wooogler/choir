import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDocUsage, getGaps, getSummary, getTopics } from 'services/dashboard/dashboard-api';
import { insertQaEvent, insertTopic, setEventTopic, setTopicLabels } from 'services/dashboard/qa-event-store';
import { closeDatabase } from 'services/db/connection';

const WS = 'T-api';

interface SeedOpts {
  topicId?: number;
  userHash?: string;
  canAnswer?: boolean;
  isoWeek?: string;
  createdAt?: number;
  chunks?: Array<{ fileName: string; sectionId?: string; headingPath?: string }>;
}

function seed(opts: SeedOpts = {}): number {
  const id = insertQaEvent({
    workspaceId: WS,
    createdAt: opts.createdAt ?? Date.now(),
    isoWeek: opts.isoWeek ?? '2026-W29',
    channelType: 'dm',
    canAnswer: opts.canAnswer ?? true,
    searchResults: 1,
    userHash: opts.userHash ?? 'u1',
    paraphrase: 'q',
    chunks: opts.chunks ?? [],
  });
  if (opts.topicId != null) setEventTopic(id, opts.topicId);
  return id;
}

describe('dashboard-api', () => {
  let tempDir: string;

  beforeEach(() => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-api-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
  });
  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  });

  describe('k-anonymity in getTopics', () => {
    it('exposes a topic asked by >= 2 distinct users and folds a single-user topic into Other', () => {
      const shared = insertTopic(WS, 'Travel funding', 'Is travel funding available?', 1);
      const solo = insertTopic(WS, 'Solo topic', 'My very specific question?', 1);

      seed({ topicId: shared, userHash: 'alice' });
      seed({ topicId: shared, userHash: 'bob' }); // 2 distinct users -> exposed
      seed({ topicId: solo, userHash: 'carol' });
      seed({ topicId: solo, userHash: 'carol' }); // 1 distinct user -> hidden

      const { topics, other } = getTopics(WS);
      expect(topics.map((t) => t.topicId)).toEqual([shared]);
      expect(topics[0].label).toBe('Travel funding');
      expect(topics[0].total).toBe(2);
      expect(other.count).toBe(2); // the two solo-topic events folded in
    });

    it('folds unclustered (topic_id NULL) events into Other regardless of user count', () => {
      seed({ userHash: 'alice' }); // no topic
      seed({ userHash: 'bob' }); // no topic — 2 distinct users but still not a topic
      const { topics, other } = getTopics(WS);
      expect(topics).toHaveLength(0);
      expect(other.count).toBe(2);
    });

    it('includes weekly counts for an exposed topic', () => {
      const t = insertTopic(WS, 'T', 'q?', 1);
      seed({ topicId: t, userHash: 'a', isoWeek: '2026-W10' });
      seed({ topicId: t, userHash: 'b', isoWeek: '2026-W10' });
      seed({ topicId: t, userHash: 'a', isoWeek: '2026-W11' });
      const { topics } = getTopics(WS);
      expect(topics[0].weeklyCounts).toEqual({ '2026-W10': 2, '2026-W11': 1 });
    });
  });

  describe('localized topic labels', () => {
    /** A k-anonymous topic (2 distinct users) with a Korean translation stored. */
    function seedTranslatedTopic(): number {
      const topicId = insertTopic(WS, 'Travel funding', 'Is travel funding available?', 1);
      setTopicLabels(topicId, { ko: { label: '출장 지원금', representative: '출장 지원금을 받을 수 있나요?' } });
      seed({ topicId, userHash: 'alice', canAnswer: false });
      seed({ topicId, userHash: 'bob', canAnswer: false });
      return topicId;
    }

    it('returns the Korean label for lang=ko when one is stored', () => {
      seedTranslatedTopic();
      const { topics } = getTopics(WS, 12, Date.now(), 'ko');
      expect(topics[0].label).toBe('출장 지원금');
      expect(topics[0].representative).toBe('출장 지원금을 받을 수 있나요?');
      expect(topics[0].labelLocale).toBe('ko');
    });

    it('falls back to English (labelLocale "en") when the locale is missing', () => {
      const topicId = insertTopic(WS, 'Reimbursement', 'How do I get reimbursed?', 1);
      seed({ topicId, userHash: 'alice' });
      seed({ topicId, userHash: 'bob' });

      const { topics } = getTopics(WS, 12, Date.now(), 'ko');
      expect(topics[0].label).toBe('Reimbursement');
      expect(topics[0].labelLocale).toBe('en');
    });

    it('serves English by default and for an unsupported language', () => {
      seedTranslatedTopic();
      for (const lang of [undefined, 'en', 'fr', 'not-a-locale']) {
        const { topics } = getTopics(WS, 12, Date.now(), lang);
        expect(topics[0].label).toBe('Travel funding');
        expect(topics[0].labelLocale).toBe('en');
      }
    });

    it('accepts a regional tag (ko-KR) the browser may send', () => {
      seedTranslatedTopic();
      expect(getTopics(WS, 12, Date.now(), 'ko-KR').topics[0].label).toBe('출장 지원금');
    });

    it('localizes gaps the same way', () => {
      seedTranslatedTopic(); // both events are unanswered
      const { gaps } = getGaps(WS, 12, Date.now(), 'ko');
      expect(gaps[0].label).toBe('출장 지원금');
      expect(gaps[0].labelLocale).toBe('ko');
      expect(getGaps(WS).gaps[0].label).toBe('Travel funding');
    });
  });

  describe('getSummary', () => {
    it('counts questions and answered ratio per week', () => {
      seed({ isoWeek: '2026-W10', canAnswer: true });
      seed({ isoWeek: '2026-W10', canAnswer: false });
      seed({ isoWeek: '2026-W11', canAnswer: true });
      const s = getSummary(WS);
      expect(s.totals.questions).toBe(3);
      expect(s.totals.answered).toBe(2);
      expect(s.totals.answeredRatio).toBeCloseTo(2 / 3, 6);
      expect(s.weeks).toEqual([
        { isoWeek: '2026-W10', total: 2, answered: 1, answeredRatio: 0.5 },
        { isoWeek: '2026-W11', total: 1, answered: 1, answeredRatio: 1 },
      ]);
    });

    it('excludes events older than the window', () => {
      const now = Date.UTC(2026, 6, 15);
      seed({ createdAt: now - 2 * 24 * 60 * 60 * 1000 }); // 2 days ago — inside 12wk
      seed({ createdAt: now - 200 * 24 * 60 * 60 * 1000 }); // ~28wk ago — outside
      expect(getSummary(WS, 12, now).totals.questions).toBe(1);
    });
  });

  describe('getGaps', () => {
    it('surfaces high-unanswered topics with their retrieved docs, k-anonymized', () => {
      const gap = insertTopic(WS, 'Reimbursement', 'How to reimburse?', 1);
      seed({ topicId: gap, userHash: 'a', canAnswer: false, chunks: [{ fileName: 'FAQ.md', headingPath: 'Money' }] });
      seed({ topicId: gap, userHash: 'b', canAnswer: false, chunks: [{ fileName: 'FAQ.md', headingPath: 'Money' }] });

      const solo = insertTopic(WS, 'Solo', 'x?', 1);
      seed({ topicId: solo, userHash: 'c', canAnswer: false });

      const { gaps, other } = getGaps(WS);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].topicId).toBe(gap);
      expect(gaps[0].unanswered).toBe(2);
      expect(gaps[0].relatedDocs[0]).toEqual({ fileName: 'FAQ.md', headingPath: 'Money', count: 2 });
      expect(other.unanswered).toBe(1); // solo topic folded in
    });
  });

  describe('getDocUsage', () => {
    it('aggregates per-file retrieval counts (no k-anonymity — document level)', () => {
      seed({ userHash: 'a', chunks: [{ fileName: 'A.md' }, { fileName: 'B.md' }] });
      seed({ userHash: 'a', canAnswer: false, chunks: [{ fileName: 'A.md' }] });
      const usage = getDocUsage(WS) as { files: Array<{ fileName: string; retrievals: number; unanswered: number }> };
      const a = usage.files.find((f) => f.fileName === 'A.md');
      expect(a?.retrievals).toBe(2);
      expect(a?.unanswered).toBe(1);
    });

    it('returns per-section detail when a file is given', () => {
      seed({ chunks: [{ fileName: 'A.md', sectionId: 's1', headingPath: 'Intro' }] });
      seed({ chunks: [{ fileName: 'A.md', sectionId: 's1', headingPath: 'Intro' }] });
      const detail = getDocUsage(WS, 12, Date.now(), 'A.md') as {
        file: string;
        sections: Array<{ sectionId: string | null; retrievals: number }>;
      };
      expect(detail.file).toBe('A.md');
      expect(detail.sections[0]).toMatchObject({ sectionId: 's1', retrievals: 2 });
    });
  });
});
