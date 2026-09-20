import { GLOSSARY_TEMPLATE, parseGlossaryMarkdown } from '../services/glossary/parse';

/**
 * The glossary is written by hand in someone's repository, so the parser is
 * tested the way hand-written markdown actually arrives: ragged spacing,
 * headers in whatever language the team uses, escaped pipes, and a table that
 * is not a glossary sitting in the same file.
 */

const FILE = 'meetings/GLOSSARY.md';

describe('parseGlossaryMarkdown', () => {
  it('reads the first three columns whatever the headers say', () => {
    const markdown = [
      '# 용어집',
      '',
      '| 용어 | 다른 표기 | 설명 |',
      '| --- | --- | --- |',
      '| CHOIR | 코이어, 콰이어, choir | 이 프로젝트. Slack 지식 봇 |',
      '| QMD | 큐엠디 | 로컬 검색 인덱스 |',
    ].join('\n');

    expect(parseGlossaryMarkdown(markdown, FILE)).toEqual([
      {
        term: 'CHOIR',
        aliases: ['코이어', '콰이어', 'choir'],
        description: '이 프로젝트. Slack 지식 봇',
        section: '용어집',
        file: FILE,
      },
      { term: 'QMD', aliases: ['큐엠디'], description: '로컬 검색 인덱스', section: '용어집', file: FILE },
    ]);
  });

  it('survives ragged spacing, extra columns and an empty alias cell', () => {
    const markdown = [
      '|Term|Also known as|Description|Owner|',
      '|:--|:-:|--:|---|',
      '|RAG||Retrieval-Augmented Generation|Search team|',
      '|  Flex   |  flex tier  |  A cheaper service tier  | Ops |',
    ].join('\n');

    expect(parseGlossaryMarkdown(markdown, FILE)).toEqual([
      { term: 'RAG', aliases: [], description: 'Retrieval-Augmented Generation', file: FILE },
      { term: 'Flex', aliases: ['flex tier'], description: 'A cheaper service tier', file: FILE },
    ]);
  });

  it('splits aliases on the ASCII and the IME separators alike', () => {
    const markdown = [
      '| a | b | c |',
      '| --- | --- | --- |',
      '| CHOIR | 코이어、콰이어; choir , Choir | The bot |',
    ].join('\n');

    expect(parseGlossaryMarkdown(markdown, FILE)[0].aliases).toEqual(['코이어', '콰이어', 'choir', 'Choir']);
  });

  it('keeps an escaped pipe and inline code as text', () => {
    const markdown = [
      '| a | b | c |',
      '| --- | --- | --- |',
      '| `@tobilu/qmd` | qmd | The index, built with \\| piped input |',
    ].join('\n');

    const [entry] = parseGlossaryMarkdown(markdown, FILE);
    expect(entry.term).toBe('@tobilu/qmd');
    expect(entry.description).toBe('The index, built with | piped input');
  });

  it('labels each table with the nearest heading above it', () => {
    const markdown = [
      '# Glossary',
      '',
      '## Systems',
      '',
      '| a | b | c |',
      '| --- | --- | --- |',
      '| QMD | 큐엠디 | The index |',
      '',
      '## Research',
      '',
      '| a | b | c |',
      '| --- | --- | --- |',
      '| RAG | 래그 | Retrieval-Augmented Generation |',
    ].join('\n');

    expect(parseGlossaryMarkdown(markdown, FILE).map((entry) => [entry.term, entry.section])).toEqual([
      ['QMD', 'Systems'],
      ['RAG', 'Research'],
    ]);
  });

  it('skips rows with no term, a stray separator row, and tables under three columns', () => {
    const markdown = [
      '| a | b | c |',
      '| --- | --- | --- |',
      '| --- | --- | --- |',
      '|  | 코이어 | No term, so no entry |',
      '| CHOIR | | The bot |',
      '',
      '| Two | Columns |',
      '| --- | --- |',
      '| Ignored | Not a glossary |',
    ].join('\n');

    expect(parseGlossaryMarkdown(markdown, FILE).map((entry) => entry.term)).toEqual(['CHOIR']);
  });

  it('is empty for an empty file and for one with no table', () => {
    expect(parseGlossaryMarkdown('', FILE)).toEqual([]);
    expect(parseGlossaryMarkdown('# Glossary\n\nNothing here yet.\n', FILE)).toEqual([]);
  });
});

describe('GLOSSARY_TEMPLATE', () => {
  it('is an empty table a person can start typing into, in either language', () => {
    expect(GLOSSARY_TEMPLATE('ko')).toBe('# 용어집\n\n| 용어 | 다른 표기 | 설명 |\n| --- | --- | --- |\n');
    expect(GLOSSARY_TEMPLATE('en')).toBe('# Glossary\n\n| Term | Also known as | Description |\n| --- | --- | --- |\n');
  });

  it('parses back as a glossary with no entries', () => {
    expect(parseGlossaryMarkdown(GLOSSARY_TEMPLATE('ko'), FILE)).toEqual([]);
  });
});
