/**
 * The pipeline, with a fake model on the other end.
 *
 * What matters here is everything *around* the call: that a long meeting is cut
 * on utterance boundaries, that every request carries the glossary, the
 * participants and the manager's one line, that names are masked before the
 * prompt leaves and restored after the answer arrives, and that a model which
 * summarised instead of transcribing is reported rather than trusted.
 */

// The mapping lives on disk and is shared with the QA path; the round trip is
// what this suite is checking, not the dictionary behind it.
jest.mock('services/anonymization/anonymization-service', () => {
  const anonymizeText = jest.fn((text: string) => text.split('이상욱').join('PERSON_A'));
  const deAnonymizeText = jest.fn((text: string) => text.split('PERSON_A').join('이상욱'));
  // `services/common/name-cache` re-binds the singleton's methods at import
  // time, and it is pulled in transitively by the locale resolver.
  return {
    anonymizeText,
    deAnonymizeText,
    anonymizationService: {
      anonymizeText,
      deAnonymizeText,
      getAnonymizationMapping: jest.fn(),
      purgeWorkspace: jest.fn(),
    },
  };
});

import { anonymizeText, deAnonymizeText } from 'services/anonymization/anonymization-service';
import type { GlossaryEntry } from 'services/glossary/parse';
import { chunkSegments, convertMeeting, resolveSpeakerMap } from 'services/import/sources/meeting';
import type { MeetingMeta } from 'services/import/sources/meeting/meta';
import type { PdfLlmClient } from 'services/import/sources/pdf';
import type { LoadedTranscript, Segment } from 'services/import/sources/text';
import { transcriptStats } from 'services/import/sources/text/segments';
import type { ImportProgressEvent } from 'services/import/types';

const META: MeetingMeta = {
  title: '주간 동기화 회의',
  date: '2026-09-20',
  folder: 'meetings',
  fileName: '2026-09-20-weekly.md',
  participants: ['이상욱', '김민지'],
  context: 'CHOIR 주간 회의',
  format: 'notes',
};

const GLOSSARY: GlossaryEntry[] = [
  { term: 'CHOIR', aliases: ['코이어', '콰이어'], description: '이 프로젝트', file: 'GLOSSARY.md' },
];

function transcriptOf(segments: Segment[]): LoadedTranscript {
  return { kind: 'transcript-text', segments, stats: transcriptStats(segments) };
}

const SHORT = transcriptOf([
  { speaker: '이상욱', start: 3, end: 20, text: '어, 코이어 인덱스 재생성 이야기부터 하죠.' },
  { speaker: '김민지', start: 20, end: 60, text: '어제 야간 재생성으로 바꿔서 올렸습니다.' },
  { speaker: '이상욱', start: 60, end: 120, text: '스테이징에는 아직 예전 답이 그대로 나오던데요.' },
  { speaker: '김민지', start: 120, end: 200, text: '캐시를 다시 데우면 해결됩니다. 오늘 안에 하겠습니다.' },
  { speaker: '이상욱', start: 200, end: 260, text: '그러면 재생성은 매일 밤에 도는 걸로 정하겠습니다.' },
  { speaker: '김민지', start: 260, end: 320, text: '네, 문서에도 그렇게 적어 두겠습니다.' },
  { speaker: '이상욱', start: 320, end: 380, text: '박준호 씨 쪽 스테이징 확인도 같이 부탁드립니다.' },
  { speaker: '김민지', start: 380, end: 3480, text: '확인하고 결과를 채널에 공유하겠습니다.' },
]);

const CHUNK_ANSWER = [
  '## 인덱스 재생성',
  '',
  '**이상욱**: CHOIR 인덱스 재생성 이야기부터 하죠.',
  '',
  '**김민지**: 어제 야간 재생성으로 바꿔서 올렸습니다.',
  '',
  '**이상욱**: 스테이징에는 아직 예전 답이 그대로 나오던데요.',
  '',
  '**김민지**: 캐시를 다시 데우면 해결됩니다. 오늘 안에 하겠습니다.',
  '',
  '**이상욱**: 그러면 재생성은 매일 밤에 도는 걸로 정하겠습니다.',
  '',
  '**김민지**: 네, 문서에도 그렇게 적어 두겠습니다.',
  '',
  '**이상욱**: 박준호 씨 쪽 스테이징 확인도 같이 부탁드립니다.',
  '',
  '**김민지**: 확인하고 결과를 채널에 공유하겠습니다.',
  '',
  '<chunk-summary>',
  '- 인덱스 재생성 주기를 논의했다',
  '- 김민지가 야간 재생성으로 바꿨다',
  '</chunk-summary>',
  '<unknown-terms>',
  '- 큐엠디',
  '- RRF',
  '</unknown-terms>',
].join('\n');

const REDUCE_ANSWER = JSON.stringify({
  summary: ['인덱스 재생성 주기를 매일 밤으로 바꿨다.'],
  decisions: ['야간 재생성을 기본으로 한다.'],
  actionItems: [{ task: '스테이징 캐시 재예열', owner: '<@U123> 김민지', due: '2026-09-22' }],
  discussion: [{ topic: '검색 품질', points: ['예전 답이 남아 있었다.'] }],
});

interface Recorded {
  model: string;
  prompt: string;
  serviceTier?: string;
}

/** A client that answers with whatever the test queued, and records the ask. */
function fakeClient(answers: string[]): { client: PdfLlmClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const queue = [...answers];

  const client: PdfLlmClient = {
    responses: {
      create: async (body) => {
        const message = (body.input as Array<{ content: Array<{ text: string }> }>)[0];
        calls.push({ model: body.model, prompt: message.content[0].text, serviceTier: body.service_tier });
        return { output_text: queue.shift() ?? '', usage: { input_tokens: 100, output_tokens: 50 } };
      },
    },
    post: async () => ({}),
  };

  return { client, calls };
}

const run = (overrides: Record<string, unknown> = {}, answers = [CHUNK_ANSWER, REDUCE_ANSWER]) => {
  const { client, calls } = fakeClient(answers);
  return {
    calls,
    result: convertMeeting({
      workspaceId: 'T1',
      transcript: SHORT,
      meta: META,
      filename: 'weekly.txt',
      glossary: GLOSSARY,
      language: 'ko',
      client,
      model: 'gpt-5.4-mini',
      ...overrides,
    }),
  };
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('convertMeeting: the prompts', () => {
  it('puts the glossary, the participants and the one-line context in every chunk', async () => {
    const { calls, result } = run();
    await result;

    const chunkPrompt = calls[0].prompt;
    expect(chunkPrompt).toContain('CHOIR (코이어, 콰이어): 이 프로젝트');
    expect(chunkPrompt).toContain('CHOIR 주간 회의');
    expect(chunkPrompt).toContain('김민지');
    expect(chunkPrompt).toContain('코이어 인덱스 재생성 이야기부터 하죠.');
    // The record's shape is dictated, not hoped for.
    expect(chunkPrompt).toContain('`**Name**: what they said`');
    expect(chunkPrompt).toContain('<unknown-terms>');
  });

  it('tells the reduce step what the chunks reported, not the whole transcript', async () => {
    const { calls, result } = run();
    await result;

    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('인덱스 재생성 주기를 논의했다');
    expect(calls[1].prompt).toContain('"actionItems"');
    expect(calls[1].prompt).toContain('never a Slack mention');
  });

  it('skips the reduce step for the 정리된 transcript format', async () => {
    const { calls, result } = run({ meta: { ...META, format: 'transcript' } }, [CHUNK_ANSWER]);
    const document = await result;

    expect(calls).toHaveLength(1);
    expect(document.markdown).toContain('## 전체 기록');
    expect(document.markdown).not.toContain('## 요약');
  });

  it('names the alias groups a project knows without naming the people', async () => {
    const { calls, result } = run({ aliasGroups: [['이상욱', 'SW', '상욱']] });
    await result;
    expect(calls[0].prompt).toContain('SW');
  });
});

describe('convertMeeting: anonymization', () => {
  it('masks on the way out and restores on the way in', async () => {
    const { calls, result } = run({}, [CHUNK_ANSWER.split('이상욱').join('PERSON_A'), REDUCE_ANSWER]);
    const document = await result;

    // What actually left the process had the pseudonym in it …
    expect(calls[0].prompt).toContain('PERSON_A');
    expect(calls[0].prompt).not.toContain('이상욱');
    // … and what landed in the document has the real name back.
    expect(document.markdown).toContain('**이상욱**');
    expect(document.markdown).not.toContain('PERSON_A');

    expect(anonymizeText).toHaveBeenCalledTimes(2);
    expect(deAnonymizeText).toHaveBeenCalledTimes(2);
    expect(anonymizeText).toHaveBeenCalledWith(expect.any(String), 'T1');
  });
});

describe('convertMeeting: the document', () => {
  it('assembles the note the template draws, with the model filling only the sections', async () => {
    const document = await run().result;

    expect(document.title).toBe('주간 동기화 회의');
    expect(document.markdown).toContain('# 주간 동기화 회의');
    expect(document.markdown).toContain('| 2026-09-20 | 이상욱, 김민지 | CHOIR 주간 회의 |');
    expect(document.markdown).toContain('- 야간 재생성을 기본으로 한다.');
    expect(document.markdown).toContain('### 검색 품질');
    expect(document.markdown).toContain('**김민지**: 어제 야간 재생성으로 바꿔서 올렸습니다.');
    // The bookkeeping blocks are parsed out, never committed.
    expect(document.markdown).not.toContain('<chunk-summary>');
    expect(document.markdown).not.toContain('<unknown-terms>');
  });

  it('strips a Slack mention out of an owner the model wrote one into', async () => {
    const document = await run().result;
    expect(document.markdown).toContain('| 스테이징 캐시 재예열 | 김민지 | 2026-09-22 |');
    expect(document.markdown).not.toContain('<@U123>');
  });

  it('reports the unknown terms once each, for the glossary card', async () => {
    const document = await run({}, [`${CHUNK_ANSWER}\n<unknown-terms>\n- 큐엠디\n</unknown-terms>`, REDUCE_ANSWER])
      .result;
    expect(document.unknownTerms).toEqual(['큐엠디', 'RRF']);
  });

  it('describes itself as a meeting, with its length and its speaker count', async () => {
    const document = await run().result;
    expect(document.source).toEqual({ kind: 'meeting', name: 'weekly.txt', minutes: 58, speakers: 2 });
  });

  it('calls a paste a paste', async () => {
    const document = await run({ filename: undefined }).result;
    expect(document.source.name).toBe('pasted transcript');
  });

  it('survives a reduce answer that is not JSON at all', async () => {
    const document = await run({}, [CHUNK_ANSWER, 'Sorry, I could not do that.']).result;

    expect(document.markdown).toContain('## 요약');
    expect(document.markdown).toContain('없음');
    // The expensive half is still there.
    expect(document.markdown).toContain('**김민지**');
  });

  it('refuses when no chunk produced a record at all', async () => {
    await expect(run({}, ['', '']).result).rejects.toMatchObject({ code: 'import_conversion_failed' });
  });
});

describe('convertMeeting: chunking and progress', () => {
  it('cuts between utterances, never inside one', () => {
    const segments: Segment[] = [
      { speaker: 'A', text: 'x'.repeat(40) },
      { speaker: 'B', text: 'y'.repeat(40) },
      { speaker: 'C', text: 'z'.repeat(40) },
    ];
    const chunks = chunkSegments(segments, 12);

    expect(chunks).toHaveLength(3);
    expect(chunks.flat()).toEqual(segments);
  });

  it('keeps an utterance bigger than a whole chunk in one piece', () => {
    const chunks = chunkSegments([{ speaker: 'A', text: 'x'.repeat(5000) }], 10);
    expect(chunks).toEqual([[{ speaker: 'A', text: 'x'.repeat(5000) }]]);
  });

  it('calls the model once per chunk, in order, and counts them out', async () => {
    // ~7k tokens of Latin text: over the 6k chunk budget, so it is cut in two.
    const long = transcriptOf(
      Array.from({ length: 40 }, (_, index) => ({ speaker: `S${index % 3}`, text: `${'word '.repeat(140)}${index}` })),
    );

    const events: ImportProgressEvent[] = [];
    const { client, calls } = fakeClient([CHUNK_ANSWER, CHUNK_ANSWER, REDUCE_ANSWER]);
    await convertMeeting({
      workspaceId: 'T1',
      transcript: long,
      meta: META,
      glossary: GLOSSARY,
      language: 'ko',
      client,
      model: 'gpt-5.4-mini',
      onProgress: (event) => events.push(event),
    });

    expect(calls.length).toBeGreaterThanOrEqual(3);
    const converting = events.filter((event) => event.step === 'converting' && event.total);
    expect(converting[0]).toMatchObject({ current: 1, total: converting.length });
    expect(events[events.length - 1].step).toBe('ready');
  });
});

describe('convertMeeting: warnings', () => {
  it('warns when the record is a summary rather than a transcript', async () => {
    const summarised = ['**이상욱**: 인덱스 이야기.', '<chunk-summary>', '- 짧게 끝났다', '</chunk-summary>'].join(
      '\n',
    );
    const document = await run({}, [summarised, REDUCE_ANSWER]).result;

    const warning = document.warnings.find((entry) => entry.code === 'low_fidelity');
    expect(warning).toBeDefined();
    expect(typeof warning?.detail?.score).toBe('number');
  });

  it("says nothing when the record kept the meeting's words", async () => {
    const document = await run().result;
    expect(document.warnings).toEqual([]);
  });

  it('counts the speakers it could not place, on the same warning', async () => {
    const anonymous = transcriptOf([
      { speaker: 'Speaker 1', text: '인덱스 재생성 주기를 매일 밤으로 바꾸는 게 좋겠습니다.' },
      { speaker: 'Speaker 2', text: '스테이징 캐시도 같이 다시 데워야 합니다.' },
    ]);
    // A record that shares almost nothing with what was said — the failure the
    // fidelity check exists for, here on top of two unplaceable labels.
    const document = await run({ transcript: anonymous }, [
      '**Speaker 1**: They talked about the schedule.',
      REDUCE_ANSWER,
    ]).result;

    expect(document.warnings[0]).toMatchObject({ code: 'low_fidelity', detail: { unknownSpeakers: 2 } });
  });
});

describe('resolveSpeakerMap', () => {
  it('maps a label that is a participant, however it was spaced or cased', () => {
    expect(resolveSpeakerMap(['sangwook  lee', '이상욱'], ['Sangwook Lee', '이상욱'], [])).toEqual({
      'sangwook  lee': 'Sangwook Lee',
      이상욱: '이상욱',
    });
  });

  it('uses an alias group to reach a participant, since the group carries no name', () => {
    expect(resolveSpeakerMap(['SW'], ['이상욱'], [['이상욱', 'SW', '상욱']])).toEqual({ SW: '이상욱' });
  });

  it('leaves a group with nobody in the room alone', () => {
    expect(resolveSpeakerMap(['SW'], ['김민지'], [['이상욱', 'SW']])).toEqual({});
  });

  it('leaves a generic label unmapped rather than guessing', () => {
    expect(resolveSpeakerMap(['Speaker 1', '참석자 2'], ['이상욱', '김민지'], [])).toEqual({});
  });
});
