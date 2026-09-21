import { detectTextKind, isSupportedTranscriptFile, transcriptLineRatio } from 'services/import/sources/text/detect';

/**
 * Detection decides how a file is read, and every meeting note's structure
 * follows from it. The cases here are the four exporters the design names —
 * Zoom, Teams, Clova Note, Otter — plus the two ways it must not fire: a
 * document that merely mentions a time, and prose with a colon in it.
 */

const ZOOM = `00:00:03 Sangwook Lee: Morning everyone, let's get started.
00:00:09 Minji Kim: I pushed the retrieval change last night.
00:00:21 Sangwook Lee: Did the index rebuild finish?
00:00:28 Minji Kim: It finished around midnight.
00:00:35 Junho Park: I still see the old answers in staging.
00:00:44 Minji Kim: I will re-warm the cache after this call.`;

const TEAMS = `Sangwook Lee   0:03
Morning everyone, let's get started.

Minji Kim   0:31
I pushed the retrieval change last night, so the index should be current.

Junho Park   1:02
I still see the old answers in staging though.`;

const CLOVA = `참석자 1 00:03 안녕하세요, 주간 회의 시작하겠습니다.
참석자 2 00:31 어제 검색 쪽 수정해서 올렸습니다.
참석자 1 01:02 인덱스 재생성은 끝났나요?
참석자 2 01:20 자정쯤에 끝났습니다.
참석자 3 01:44 스테이징에는 아직 예전 답이 나옵니다.
참석자 2 02:03 통화 끝나고 캐시를 다시 데우겠습니다.`;

const OTTER = `Speaker 1  0:00
Morning everyone, let's get started.

Speaker 2  0:31
I pushed the retrieval change last night.

Speaker 1  1:02
Did the index rebuild finish?`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Sangwook Lee>Morning everyone.</v>`;

const SRT = `1
00:00:01,000 --> 00:00:04,000
Sangwook Lee: Morning everyone.

2
00:00:04,500 --> 00:00:07,000
Minji Kim: I pushed the change.`;

const PROSE = `# Retrieval notes

The weekly sync is at 10:30 every Monday. We agreed to rebuild the index
nightly, which takes about forty minutes and finishes well before anyone
is awake to notice it.

Note: the staging cache is warmed separately, by hand, after each deploy.`;

describe('detectTextKind: the extension', () => {
  it('believes the name first', () => {
    expect(detectTextKind({ filename: 'weekly.vtt', text: VTT })).toBe('vtt');
    expect(detectTextKind({ filename: 'weekly.srt', text: SRT })).toBe('srt');
    expect(detectTextKind({ filename: 'notes.docx', bytes: Buffer.from('PK') })).toBe('docx');
  });

  it('keeps `.md` for a markdown file with no transcript in it', () => {
    expect(detectTextKind({ filename: 'notes.md', text: PROSE })).toBe('markdown');
  });

  it('still finds the transcript inside a file that was saved as `.md`', () => {
    expect(detectTextKind({ filename: 'weekly.md', text: TEAMS })).toBe('transcript-text');
  });

  it('answers on bytes alone, the way a paste arrives', () => {
    expect(detectTextKind({ bytes: Buffer.from(ZOOM, 'utf8') })).toBe('transcript-text');
    expect(detectTextKind({ text: '' })).toBe('plain');
  });
});

describe('detectTextKind: the content', () => {
  it('reads a WEBVTT header even with a byte-order mark in front of it', () => {
    expect(detectTextKind({ text: VTT })).toBe('vtt');
    expect(detectTextKind({ text: `﻿${VTT}` })).toBe('vtt');
  });

  it('recognizes SubRip by its cue numbering', () => {
    expect(detectTextKind({ text: SRT })).toBe('srt');
  });

  it.each([
    ['Zoom', ZOOM],
    ['Teams', TEAMS],
    ['Clova Note', CLOVA],
    ['Otter', OTTER],
  ])('recognizes a %s export', (_name, sample) => {
    expect(detectTextKind({ filename: 'meeting.txt', text: sample })).toBe('transcript-text');
  });

  it('leaves an ordinary document alone', () => {
    expect(detectTextKind({ filename: 'meeting.txt', text: PROSE })).toBe('plain');
    expect(transcriptLineRatio(PROSE)).toBeLessThan(0.6);
  });

  it('does not call three lines a transcript', () => {
    expect(transcriptLineRatio('00:01 hello\n00:02 there\n00:03 again')).toBe(0);
  });

  it('counts the words under a Teams header as part of the utterance', () => {
    // The whole point of coverage rather than line matching: half of a Teams
    // export is body text, which would put a real transcript at 50%.
    expect(transcriptLineRatio(TEAMS)).toBe(1);
  });
});

describe('isSupportedTranscriptFile', () => {
  it('accepts the formats the dialog offers, and a nameless paste', () => {
    for (const name of ['a.vtt', 'a.srt', 'a.txt', 'a.md', 'a.markdown', 'a.docx', 'A.VTT', undefined, 'transcript']) {
      expect([name, isSupportedTranscriptFile(name)]).toEqual([name, true]);
    }
  });

  it('refuses anything else by name, before a byte is read', () => {
    for (const name of ['deck.pptx', 'scan.pdf', 'audio.m4a', 'notes.rtf']) {
      expect([name, isSupportedTranscriptFile(name)]).toEqual([name, false]);
    }
  });
});
