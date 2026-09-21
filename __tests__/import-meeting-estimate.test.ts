import type { GlossaryEntry } from 'services/glossary/parse';
import { glossaryPromptBlock } from 'services/glossary/prompt-block';
import { estimateMeetingImport } from 'services/import/sources/meeting/estimate';
import type { MeetingMeta } from 'services/import/sources/meeting/meta';
import type { LoadedTranscript, Segment } from 'services/import/sources/text';
import { transcriptStats } from 'services/import/sources/text/segments';

/**
 * The number a manager approves a bill against. It asks nothing — a transcript
 * is text, so counting it is local and free — which makes the thing worth
 * checking that it counts the *same* payload the conversion will send: the same
 * chunking, the same prompts, the same glossary block.
 */

const META: MeetingMeta = {
  title: 'Weekly sync',
  date: '2026-09-20',
  folder: 'meetings',
  fileName: 'weekly.md',
  participants: ['Sangwook Lee', 'Minji Kim'],
  context: 'CHOIR weekly',
  format: 'notes',
};

const GLOSSARY: GlossaryEntry[] = [
  { term: 'CHOIR', aliases: ['코이어'], description: 'this project', file: 'GLOSSARY.md' },
];

function transcriptOf(segments: Segment[]): LoadedTranscript {
  return { kind: 'transcript-text', segments, stats: transcriptStats(segments) };
}

const HOUR = transcriptOf(
  Array.from({ length: 60 }, (_, index) => ({
    speaker: index % 2 === 0 ? 'Sangwook Lee' : 'Minji Kim',
    start: index * 58,
    end: index * 58 + 57,
    text: `${'word '.repeat(120)}${index}`,
  })),
);

const estimate = (overrides: Record<string, unknown> = {}) =>
  estimateMeetingImport({
    transcript: HOUR,
    meta: META,
    model: 'gpt-5.4-mini',
    serviceTier: 'flex',
    ...overrides,
  });

describe('estimateMeetingImport', () => {
  it('reports what the dialog shows about the transcript itself', () => {
    const result = estimate();

    expect(result.utterances).toBe(60);
    expect(result.speakers).toBe(2);
    expect(result.minutes).toBe(58);
    expect(result.chunks).toBeGreaterThan(1);
  });

  it('prices input and output against the configured model and tier', () => {
    const flex = estimate();
    const standard = estimate({ serviceTier: 'default' });

    expect(flex.model).toBe('gpt-5.4-mini');
    expect(flex.serviceTier).toBe('flex');
    expect(flex.inputTokens).toBeGreaterThan(0);
    expect(flex.estimatedUsd).toBeCloseTo((standard.estimatedUsd ?? 0) / 2, 8);
  });

  it('has no price for a model it does not know', () => {
    expect(estimate({ model: 'some-local-model' }).estimatedUsd).toBeUndefined();
  });

  it('counts the glossary block, because the conversion pays for it too', () => {
    const block = glossaryPromptBlock(GLOSSARY, { text: 'CHOIR', maxTokens: 1500 });
    expect(block).not.toBe('');

    expect(estimate({ glossaryBlock: block }).inputTokens).toBeGreaterThan(estimate().inputTokens);
  });

  it('charges the transcript format less: no reduce call and no reduce output', () => {
    const notes = estimate();
    const transcript = estimate({ meta: { ...META, format: 'transcript' } });

    expect(transcript.inputTokens).toBeLessThan(notes.inputTokens);
    expect(notes.estimatedOutputTokens - transcript.estimatedOutputTokens).toBe(1500);
  });

  it('grows with the transcript, and reports no minutes without a clock', () => {
    const pasted = transcriptOf([{ text: 'A short pasted note.' }]);
    const small = estimate({ transcript: pasted });

    expect(small.minutes).toBeUndefined();
    expect(small.chunks).toBe(1);
    expect(small.inputTokens).toBeLessThan(estimate().inputTokens);
  });

  it('is a plain object — nothing here went to the network', () => {
    expect(estimate()).toEqual(
      expect.objectContaining({
        utterances: expect.any(Number),
        speakers: expect.any(Number),
        chunks: expect.any(Number),
        inputTokens: expect.any(Number),
        estimatedOutputTokens: expect.any(Number),
        model: 'gpt-5.4-mini',
        serviceTier: 'flex',
      }),
    );
  });
});
