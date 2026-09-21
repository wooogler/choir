import { loadTranscript } from 'services/import/sources/text';
import {
  mergeSegments,
  parseSrt,
  parseTimestamp,
  parseTranscriptText,
  parseVtt,
  plainToSegments,
  transcriptStats,
} from 'services/import/sources/text/segments';
import { ImportRefusal } from 'services/import/types';

/**
 * Parsing is where every exporter's habits are supposed to stop mattering. So
 * the assertions are all the same shape — who spoke, when, what they said —
 * against four transcripts that look nothing alike on disk.
 */

describe('parseVtt', () => {
  it("reads voice tags, drops cue markup, and merges a speaker's run", () => {
    const vtt = `WEBVTT

NOTE recorded by CHOIR

1
00:00:01.000 --> 00:00:04.000 align:start position:0%
<v Sangwook Lee>Morning everyone.</v>

2
00:00:04.500 --> 00:00:07.250
<v Sangwook Lee>Let's start with the roadmap.</v>

3
00:00:07.500 --> 00:00:11.000
<v.loud Minji Kim>I pushed the <i>retrieval</i> change.</v>`;

    expect(parseVtt(vtt)).toEqual([
      { speaker: 'Sangwook Lee', start: 1, end: 7.25, text: "Morning everyone. Let's start with the roadmap." },
      { speaker: 'Minji Kim', start: 7.5, end: 11, text: 'I pushed the retrieval change.' },
    ]);
  });

  it('takes the speaker from a `Name:` cue when there is no voice tag', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Junho Park: I still see the old answers.`;

    expect(parseVtt(vtt)).toEqual([{ speaker: 'Junho Park', start: 1, end: 4, text: 'I still see the old answers.' }]);
  });

  it('keeps a caption with no speaker at all', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
The recording has started.`;

    expect(parseVtt(vtt)).toEqual([{ speaker: undefined, start: 1, end: 4, text: 'The recording has started.' }]);
  });
});

describe('parseSrt', () => {
  it('reads comma decimals and drops the cue numbers', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Sangwook Lee: Morning everyone.

2
00:00:04,500 --> 00:00:07,000
Minji Kim: I pushed the change.`;

    expect(parseSrt(srt)).toEqual([
      { speaker: 'Sangwook Lee', start: 1, end: 4, text: 'Morning everyone.' },
      { speaker: 'Minji Kim', start: 4.5, end: 7, text: 'I pushed the change.' },
    ]);
  });
});

describe('parseTranscriptText', () => {
  it('reads Zoom: timestamp, name, words, all on one line', () => {
    const zoom = `00:00:03 Sangwook Lee: Morning everyone.
00:00:09 Minji Kim: I pushed the retrieval change.
00:01:21 Sangwook Lee: Did the index rebuild finish?`;

    expect(parseTranscriptText(zoom)).toEqual([
      { speaker: 'Sangwook Lee', start: 3, text: 'Morning everyone.' },
      { speaker: 'Minji Kim', start: 9, text: 'I pushed the retrieval change.' },
      { speaker: 'Sangwook Lee', start: 81, text: 'Did the index rebuild finish?' },
    ]);
  });

  it('reads Teams: the name and clock on one line, the words on the next', () => {
    const teams = `Sangwook Lee   0:03
Morning everyone, let's get started.
We have three things today.

Minji Kim   0:31
I pushed the retrieval change last night.`;

    expect(parseTranscriptText(teams)).toEqual([
      { speaker: 'Sangwook Lee', start: 3, text: "Morning everyone, let's get started. We have three things today." },
      { speaker: 'Minji Kim', start: 31, text: 'I pushed the retrieval change last night.' },
    ]);
  });

  it('reads Clova Note: a numbered participant, then the clock, then the words', () => {
    const clova = `참석자 1 00:03 안녕하세요, 주간 회의 시작하겠습니다.
참석자 2 00:31 어제 검색 쪽 수정해서 올렸습니다.`;

    expect(parseTranscriptText(clova)).toEqual([
      { speaker: '참석자 1', start: 3, text: '안녕하세요, 주간 회의 시작하겠습니다.' },
      { speaker: '참석자 2', start: 31, text: '어제 검색 쪽 수정해서 올렸습니다.' },
    ]);
  });

  it('reads Otter: a generic label above the words', () => {
    const otter = `Speaker 1  0:00
Morning everyone.

Speaker 2  0:31
I pushed the change.`;

    expect(parseTranscriptText(otter)).toEqual([
      { speaker: 'Speaker 1', start: 0, text: 'Morning everyone.' },
      { speaker: 'Speaker 2', start: 31, text: 'I pushed the change.' },
    ]);
  });

  it('keeps words that arrive before the first speaker line', () => {
    const withHeader = `Weekly sync — recording
00:00:03 Sangwook Lee: Morning everyone.`;

    expect(parseTranscriptText(withHeader)).toEqual([
      { text: 'Weekly sync — recording' },
      { speaker: 'Sangwook Lee', start: 3, text: 'Morning everyone.' },
    ]);
  });
});

describe('plainToSegments', () => {
  it('cuts on blank lines, so a paste can still be chunked', () => {
    expect(plainToSegments('First thought,\nwrapped.\n\n\nSecond thought.\n')).toEqual([
      { text: 'First thought, wrapped.' },
      { text: 'Second thought.' },
    ]);
  });
});

describe('mergeSegments', () => {
  it('joins a run by one speaker but not across a change of speaker', () => {
    const merged = mergeSegments([
      { speaker: 'A', text: 'one' },
      { speaker: 'A', text: 'two' },
      { speaker: 'B', text: 'three' },
      { speaker: 'A', text: 'four' },
    ]);
    expect(merged).toEqual([
      { speaker: 'A', text: 'one two' },
      { speaker: 'B', text: 'three' },
      { speaker: 'A', text: 'four' },
    ]);
  });

  it('stops merging before a run becomes too big to chunk', () => {
    const long = Array.from({ length: 10 }, () => ({ speaker: 'A', text: 'x'.repeat(200) }));
    const merged = mergeSegments(long);

    expect(merged.length).toBeGreaterThan(1);
    for (const segment of merged) expect(segment.text.length).toBeLessThanOrEqual(1200);
  });
});

describe('transcriptStats', () => {
  it('counts speakers in the order they first spoke, and reads the clock', () => {
    expect(
      transcriptStats([
        { speaker: 'Minji Kim', start: 0, end: 10, text: 'one' },
        { speaker: 'Sangwook Lee', start: 10, end: 20, text: 'two' },
        { speaker: 'Minji Kim', start: 20, end: 3480, text: 'three' },
      ]),
    ).toEqual({ speakers: ['Minji Kim', 'Sangwook Lee'], utterances: 3, durationSeconds: 3480, chars: 11 });
  });

  it('reports no duration for a transcript with no clock', () => {
    expect(transcriptStats([{ text: 'pasted notes' }]).durationSeconds).toBeUndefined();
  });
});

describe('parseTimestamp', () => {
  it('reads both lengths and both decimal separators', () => {
    expect(parseTimestamp('0:31')).toBe(31);
    expect(parseTimestamp('01:02:03')).toBe(3723);
    expect(parseTimestamp('00:00:04,500')).toBe(4.5);
    expect(parseTimestamp('not a time')).toBeUndefined();
  });
});

describe('loadTranscript', () => {
  it('routes each kind to its parser and counts what it found', async () => {
    const loaded = await loadTranscript({
      filename: 'weekly.vtt',
      text: 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Minji Kim>Morning.</v>',
    });

    expect(loaded.kind).toBe('vtt');
    expect(loaded.stats).toMatchObject({ speakers: ['Minji Kim'], utterances: 1 });
  });

  it('strips a byte-order mark rather than making it part of the first word', async () => {
    const loaded = await loadTranscript({ filename: 'notes.txt', text: '﻿Pasted notes.' });
    expect(loaded.segments[0].text).toBe('Pasted notes.');
  });

  it('refuses an empty transcript as something the manager can fix', async () => {
    await expect(loadTranscript({ text: '   \n\n ' })).rejects.toMatchObject({
      code: 'meeting_transcript_empty',
      status: 422,
    });
    await expect(loadTranscript({ text: '' })).rejects.toBeInstanceOf(ImportRefusal);
  });

  it('refuses a file it cannot open, by name', async () => {
    await expect(loadTranscript({ filename: 'deck.pptx', bytes: Buffer.from('x') })).rejects.toMatchObject({
      code: 'import_unsupported_file',
      status: 415,
    });
  });

  it('refuses more than five megabytes before decoding any of it', async () => {
    await expect(
      loadTranscript({ filename: 'huge.txt', bytes: Buffer.alloc(6 * 1024 * 1024, 97) }),
    ).rejects.toMatchObject({ code: 'import_too_large', detail: { maxMb: 5 } });
  });
});
