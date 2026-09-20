import { parseGlossaryMarkdown } from '../services/glossary/parse';
import { appendGlossaryRows } from '../services/glossary/table';

/**
 * These rows land in a commit on someone's documentation repository, so the
 * test is about the diff: only the rows asked for, in the right table, with
 * nothing else in the file moved — and running the same request twice must not
 * produce a second copy of a term.
 */

const EXISTING = [
  '# 용어집',
  '',
  'This folder’s terms.',
  '',
  '| 용어 | 다른 표기 | 설명 |',
  '| --- | --- | --- |',
  '| CHOIR | 코이어 | Slack 지식 봇 |',
  '',
  '> A note that must stay at the bottom.',
  '',
].join('\n');

describe('appendGlossaryRows', () => {
  it('appends to the last wide table and leaves the rest of the file alone', () => {
    const result = appendGlossaryRows(EXISTING, [
      { term: 'QMD', aliases: ['큐엠디'], description: '로컬 검색 인덱스' },
    ]);

    expect(result.added).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.markdown).toBe(
      [
        '# 용어집',
        '',
        'This folder’s terms.',
        '',
        '| 용어 | 다른 표기 | 설명 |',
        '| --- | --- | --- |',
        '| CHOIR | 코이어 | Slack 지식 봇 |',
        '| QMD | 큐엠디 | 로컬 검색 인덱스 |',
        '',
        '> A note that must stay at the bottom.',
        '',
      ].join('\n'),
    );
  });

  it('picks the last glossary-shaped table, not a narrow one after it', () => {
    const markdown = [
      '| a | b | c |',
      '| --- | --- | --- |',
      '| CHOIR | 코이어 | The bot |',
      '',
      '| Key | Value |',
      '| --- | --- |',
      '| owner | ops |',
      '',
    ].join('\n');

    const { markdown: next } = appendGlossaryRows(markdown, [{ term: 'RAG', aliases: [], description: 'Retrieval' }]);
    expect(next.split('\n')[3]).toBe('| RAG |  | Retrieval |');
    expect(next).toContain('| owner | ops |');
  });

  it('creates the template table when the file has none, in the rows’ language', () => {
    const ko = appendGlossaryRows('', [{ term: 'CHOIR', aliases: ['코이어'], description: '슬랙 지식 봇' }]);
    expect(ko.markdown).toBe(
      [
        '# 용어집',
        '',
        '| 용어 | 다른 표기 | 설명 |',
        '| --- | --- | --- |',
        '| CHOIR | 코이어 | 슬랙 지식 봇 |',
        '',
      ].join('\n'),
    );

    const en = appendGlossaryRows('', [{ term: 'RAG', aliases: [], description: 'Retrieval-Augmented Generation' }]);
    expect(en.markdown).toContain('| Term | Also known as | Description |');
    expect(en.markdown).toContain('| RAG |  | Retrieval-Augmented Generation |');
  });

  it('adds a table under existing prose without inventing a second title', () => {
    const markdown = '# Team notes\n\nNo table here yet.\n';
    const { markdown: next } = appendGlossaryRows(markdown, [
      { term: 'RAG', aliases: ['래그'], description: 'Retrieval' },
    ]);

    expect(next).toBe(
      [
        '# Team notes',
        '',
        'No table here yet.',
        '',
        '| Term | Also known as | Description |',
        '| --- | --- | --- |',
        '| RAG | 래그 | Retrieval |',
        '',
      ].join('\n'),
    );
    expect(next.match(/^# /gm)).toHaveLength(1);
  });

  it('escapes a pipe so the row keeps its three columns', () => {
    const { markdown } = appendGlossaryRows(EXISTING, [
      { term: 'a|b', aliases: ['x|y'], description: 'Read as "a or b"\nover two lines' },
    ]);

    expect(markdown).toContain('| a\\|b | x\\|y | Read as "a or b" over two lines |');
    const entry = parseGlossaryMarkdown(markdown, 'GLOSSARY.md').find((row) => row.term === 'a|b');
    expect(entry).toMatchObject({ aliases: ['x|y'], description: 'Read as "a or b" over two lines' });
  });

  it('skips a term already in the file, whatever its case, and is idempotent', () => {
    const rows = [
      { term: 'choir', aliases: ['콰이어'], description: 'A duplicate' },
      { term: 'RAG', aliases: [], description: 'Retrieval' },
    ];

    const first = appendGlossaryRows(EXISTING, rows);
    expect(first.added).toBe(1);
    expect(first.skipped).toEqual(['choir']);

    const second = appendGlossaryRows(first.markdown, rows);
    expect(second.added).toBe(0);
    expect(second.skipped).toEqual(['choir', 'RAG']);
    expect(second.markdown).toBe(first.markdown);
  });

  it('writes a term repeated inside one request only once', () => {
    const result = appendGlossaryRows(EXISTING, [
      { term: 'RAG', aliases: [], description: 'First' },
      { term: 'rag', aliases: [], description: 'Second' },
    ]);

    expect(result.added).toBe(1);
    expect(result.skipped).toEqual(['rag']);
    expect(result.markdown).toContain('| RAG |  | First |');
    expect(result.markdown).not.toContain('Second');
  });

  it('returns the file untouched when there is nothing to add', () => {
    const result = appendGlossaryRows(EXISTING, []);
    expect(result).toEqual({ markdown: EXISTING, added: 0, skipped: [] });
  });
});
