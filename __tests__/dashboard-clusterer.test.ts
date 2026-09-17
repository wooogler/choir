import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEmbeddedEvents, getTopics, insertQaEvent } from 'services/dashboard/qa-event-store';
import { clusterWorkspace } from 'services/dashboard/topic-clusterer';
import { closeDatabase } from 'services/db/connection';

const WS = 'T-cluster';

// Deterministic embeddings keyed on the paraphrase's first char: A/B/C -> distinct
// orthogonal axes so A-group clusters together and separates from B and C.
const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => {
    if (t.startsWith('A')) return [1, 0, 0];
    if (t.startsWith('B')) return [0, 1, 0];
    return [0, 0, 1];
  });

const fakeLabel = async (paraphrases: string[]) => ({
  label: `L:${paraphrases[0][0]}`,
  representative: paraphrases[0],
});

function seed(paraphrase: string) {
  insertQaEvent({
    workspaceId: WS,
    createdAt: Date.now(),
    isoWeek: '2026-W29',
    channelType: 'dm',
    canAnswer: true,
    searchResults: 1,
    userHash: 'h',
    paraphrase,
    chunks: [],
  });
}

describe('clusterWorkspace', () => {
  let tempDir: string;

  beforeEach(() => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-cluster-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
  });
  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  });

  it('embeds events, groups similar ones, and labels topics', async () => {
    seed('A one');
    seed('A two');
    seed('B one');
    seed('B two');
    seed('C one');

    const result = await clusterWorkspace(WS, { embed: fakeEmbed, label: fakeLabel, threshold: 0.8, now: 1 });
    expect(result.embedded).toBe(5);
    expect(result.newTopics).toBe(3); // A, B, C
    expect(result.relabeled).toBe(3);

    const events = getEmbeddedEvents(WS);
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.topicId != null)).toBe(true);

    const topicOf = (para: string) => events.find((e) => e.paraphrase === para)?.topicId;
    expect(topicOf('A one')).toBe(topicOf('A two')); // same cluster
    expect(topicOf('A one')).not.toBe(topicOf('B one')); // different cluster
    expect(topicOf('B one')).not.toBe(topicOf('C one'));

    const topics = getTopics(WS);
    expect(topics).toHaveLength(3);
    expect(topics.every((t) => t.label.startsWith('L:'))).toBe(true);
  });

  it('is stable on re-run: nothing re-embedded, no new topics', async () => {
    seed('A one');
    seed('A two');
    await clusterWorkspace(WS, { embed: fakeEmbed, label: fakeLabel, threshold: 0.8, now: 1 });

    const second = await clusterWorkspace(WS, { embed: fakeEmbed, label: fakeLabel, threshold: 0.8, now: 2 });
    expect(second.embedded).toBe(0);
    expect(second.newTopics).toBe(0);
    expect(getTopics(WS)).toHaveLength(1);
  });

  describe('localized display labels', () => {
    const fakeTranslate = jest.fn(async (english: { label: string; representative: string }, locale: string) => ({
      label: `${locale}:${english.label}`,
      representative: `${locale}:${english.representative}`,
    }));

    beforeEach(() => fakeTranslate.mockClear());

    it('translates a new topic once per non-English locale', async () => {
      seed('A one');
      seed('B one');
      await clusterWorkspace(WS, {
        embed: fakeEmbed,
        label: fakeLabel,
        translate: fakeTranslate,
        threshold: 0.8,
        now: 1,
      });

      // Two topics x one non-English locale (ko).
      expect(fakeTranslate).toHaveBeenCalledTimes(2);
      expect(fakeTranslate).toHaveBeenCalledWith({ label: 'L:A', representative: 'A one' }, 'ko');
      const topics = getTopics(WS);
      expect(topics.map((t) => t.labels.ko?.label).sort()).toEqual(['ko:L:A', 'ko:L:B']);
    });

    it('does not re-translate a topic whose English label is unchanged', async () => {
      seed('A one');
      await clusterWorkspace(WS, { embed: fakeEmbed, label: fakeLabel, translate: fakeTranslate, threshold: 0.8 });
      expect(fakeTranslate).toHaveBeenCalledTimes(1);

      fakeTranslate.mockClear();
      seed('A two'); // joins the same topic, so it is relabeled — to the same label
      await clusterWorkspace(WS, { embed: fakeEmbed, label: fakeLabel, translate: fakeTranslate, threshold: 0.8 });
      expect(fakeTranslate).not.toHaveBeenCalled();
      expect(getTopics(WS)[0].labels.ko?.label).toBe('ko:L:A');
    });

    it('re-translates when the English label changes', async () => {
      seed('A one');
      await clusterWorkspace(WS, { embed: fakeEmbed, label: fakeLabel, translate: fakeTranslate, threshold: 0.8 });

      fakeTranslate.mockClear();
      seed('A two');
      const renamed = async () => ({ label: 'Renamed topic', representative: 'A new question?' });
      await clusterWorkspace(WS, { embed: fakeEmbed, label: renamed, translate: fakeTranslate, threshold: 0.8 });
      expect(fakeTranslate).toHaveBeenCalledTimes(1);
      expect(getTopics(WS)[0].labels.ko).toEqual({
        label: 'ko:Renamed topic',
        representative: 'ko:A new question?',
      });
    });

    it('leaves the topic English-only when translation fails', async () => {
      seed('A one');
      const failing = jest.fn(async () => null);
      await clusterWorkspace(WS, { embed: fakeEmbed, label: fakeLabel, translate: failing, threshold: 0.8 });

      const [topic] = getTopics(WS);
      expect(failing).toHaveBeenCalledTimes(1);
      expect(topic.label).toBe('L:A'); // the English label is still written
      expect(topic.labels).toEqual({}); // and nothing masquerades as Korean
    });
  });

  it('assigns a new event to an existing topic on a later run', async () => {
    seed('A one');
    await clusterWorkspace(WS, { embed: fakeEmbed, label: fakeLabel, threshold: 0.8, now: 1 });
    expect(getTopics(WS)).toHaveLength(1);

    seed('A three'); // similar to the existing A topic
    const result = await clusterWorkspace(WS, { embed: fakeEmbed, label: fakeLabel, threshold: 0.8, now: 2 });
    expect(result.embedded).toBe(1);
    expect(result.newTopics).toBe(0); // joined the existing A topic
    expect(getTopics(WS)).toHaveLength(1);

    const events = getEmbeddedEvents(WS);
    expect(new Set(events.map((e) => e.topicId)).size).toBe(1);
  });
});
