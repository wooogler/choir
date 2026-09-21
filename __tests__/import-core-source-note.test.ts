import {
  SOURCE_NOTE_MARKER,
  buildSourceNote,
  prependSourceNote,
  stripSourceNote,
} from '../services/import/source-note';
import type { ImportSourceInfo } from '../services/import/types';

/**
 * The source note is committed text in someone's repository, so it is checked
 * the way committed text has to be: it reads correctly in both languages, it
 * goes under the title rather than over it, and it can be taken back out
 * exactly — a round trip that grows blank lines or leaves a fragment behind
 * would show up as a diff on the next edit.
 */

// A fixed local date, so the formatting is the same in KST and in UTC CI.
const DAY = new Date(2026, 8, 18, 12, 0, 0);

const url: ImportSourceInfo = { kind: 'url', name: 'Example page', url: 'https://example.com/page' };
const pdf: ImportSourceInfo = { kind: 'pdf', name: 'onboarding.pdf', pages: 12 };

describe('buildSourceNote', () => {
  it('writes a web page as one blockquote line, in English and Korean', () => {
    expect(buildSourceNote(url, { language: 'en', date: DAY })).toBe(
      `> Source: https://example.com/page (imported 2026-09-18) ${SOURCE_NOTE_MARKER}`,
    );
    expect(buildSourceNote(url, { language: 'ko', date: DAY })).toBe(
      `> 출처: https://example.com/page (2026-09-18 가져옴) ${SOURCE_NOTE_MARKER}`,
    );
  });

  it('names the file and counts the pages for a PDF', () => {
    expect(buildSourceNote(pdf, { language: 'en', date: DAY })).toContain(
      'Source: onboarding.pdf (12 pages, imported 2026-09-18)',
    );
    expect(buildSourceNote(pdf, { language: 'ko', date: DAY })).toContain(
      '출처: onboarding.pdf (12쪽, 2026-09-18 가져옴)',
    );
  });

  it('counts one page as one page', () => {
    const single: ImportSourceInfo = { kind: 'pdf', name: 'memo.pdf', pages: 1 };
    expect(buildSourceNote(single, { language: 'en', date: DAY })).toContain('memo.pdf (1 page, imported');
  });

  it('leaves the page count out when the source did not report one', () => {
    const unknown: ImportSourceInfo = { kind: 'pdf', name: 'scan.pdf' };
    expect(buildSourceNote(unknown, { language: 'en', date: DAY })).toBe(
      `> Source: scan.pdf (imported 2026-09-18) ${SOURCE_NOTE_MARKER}`,
    );
  });

  it('links a Google Doc by name, and names it plainly without a url', () => {
    const doc: ImportSourceInfo = {
      kind: 'google-docs',
      name: 'Team handbook',
      url: 'https://docs.google.com/document/d/abc/edit',
    };
    const link = `[Team handbook](${doc.url})`;
    expect(buildSourceNote(doc, { language: 'en', date: DAY })).toBe(
      `> Source: Google Doc ${link} (imported 2026-09-18) ${SOURCE_NOTE_MARKER}`,
    );
    expect(buildSourceNote({ kind: 'google-docs', name: 'Team handbook' }, { language: 'ko', date: DAY })).toBe(
      `> 출처: Google 문서 Team handbook (2026-09-18 가져옴) ${SOURCE_NOTE_MARKER}`,
    );
  });

  it('sizes a meeting by its clock and its speakers, not by pages', () => {
    const meeting: ImportSourceInfo = { kind: 'meeting', name: 'weekly.vtt', minutes: 58, speakers: 4 };

    expect(buildSourceNote(meeting, { language: 'ko', date: DAY })).toBe(
      `> 출처: weekly.vtt (58분, 화자 4명, 2026-09-18 가져옴) ${SOURCE_NOTE_MARKER}`,
    );
    expect(buildSourceNote(meeting, { language: 'en', date: DAY })).toBe(
      `> Source: weekly.vtt (58 minutes, 4 speakers, imported 2026-09-18) ${SOURCE_NOTE_MARKER}`,
    );
  });

  it('names only what it knows about a meeting', () => {
    // A transcript with one speaker and no clock — a pasted wall of text.
    expect(
      buildSourceNote({ kind: 'meeting', name: 'pasted transcript', speakers: 1 }, { language: 'en', date: DAY }),
    ).toContain('pasted transcript (1 speaker, imported 2026-09-18)');

    // Neither: the plain file sentence, rather than an empty pair of brackets.
    expect(buildSourceNote({ kind: 'meeting', name: 'pasted transcript' }, { language: 'ko', date: DAY })).toBe(
      `> 출처: pasted transcript (2026-09-18 가져옴) ${SOURCE_NOTE_MARKER}`,
    );
  });

  it('keeps a multi-line name on one line', () => {
    const messy: ImportSourceInfo = { kind: 'pdf', name: 'a\nvery   long\tname.pdf' };
    expect(buildSourceNote(messy, { language: 'en', date: DAY })).toBe(
      `> Source: a very long name.pdf (imported 2026-09-18) ${SOURCE_NOTE_MARKER}`,
    );
  });
});

describe('prependSourceNote', () => {
  const note = buildSourceNote(url, { language: 'en', date: DAY });

  it('puts the note under the first heading, not above it', () => {
    expect(prependSourceNote('# Title\n\nFirst paragraph.\n', note)).toBe(`# Title\n\n${note}\n\nFirst paragraph.\n`);
  });

  it('goes first when the body has no heading', () => {
    expect(prependSourceNote('First paragraph.\n', note)).toBe(`${note}\n\nFirst paragraph.\n`);
  });

  it('ignores a `#` that is not a heading', () => {
    const body = '#hashtag\n\n# Real title\n\nBody.';
    expect(prependSourceNote(body, note)).toBe(`#hashtag\n\n# Real title\n\n${note}\n\nBody.`);
  });

  it('replaces a note that is already there instead of stacking a second one', () => {
    const once = prependSourceNote('# Title\n\nBody.', note);
    const twice = prependSourceNote(once, buildSourceNote(pdf, { language: 'en', date: DAY }));

    expect(twice.split(SOURCE_NOTE_MARKER)).toHaveLength(2);
    expect(twice).toContain('onboarding.pdf');
  });
});

describe('stripSourceNote', () => {
  it('undoes prepending exactly', () => {
    const note = buildSourceNote(url, { language: 'ko', date: DAY });
    for (const body of ['# Title\n\nBody.\n', 'No heading here.\n', '# Title\n\n## Sub\n\nBody.']) {
      expect(stripSourceNote(prependSourceNote(body, note))).toBe(body);
    }
  });

  it('removes the note wherever a person moved it', () => {
    const note = buildSourceNote(url, { language: 'en', date: DAY });
    expect(stripSourceNote(`# Title\n\nBody.\n\n${note}\n`)).toBe('# Title\n\nBody.\n');
  });

  it('recognizes the note by its marker, not its wording', () => {
    const edited = `# Title\n\n> Source: somewhere else entirely ${SOURCE_NOTE_MARKER}\n\nBody.`;
    expect(stripSourceNote(edited)).toBe('# Title\n\nBody.');
  });

  it('leaves a document that never had one alone', () => {
    const body = '# Title\n\n> An ordinary quotation.\n\nBody.';
    expect(stripSourceNote(body)).toBe(body);
  });
});
