import { convertMarkdownToSlackText } from '../services/document/markdown-format';

describe('convertMarkdownToSlackText — GFM tables', () => {
  it('renders a 3-column table as one line per row with a bold header', async () => {
    const markdown = [
      '| 근속 연수 | 연차 | 비고 |',
      '| --- | --- | --- |',
      '| 1년 미만 | 11일 | 월 1일 |',
      '| 1~3년 | 15일 | |',
      '| 3년 이상 | 20일 | 최대 25일 |',
      '',
    ].join('\n');

    const result = await convertMarkdownToSlackText(markdown);

    expect(result).toBe(
      ['*근속 연수 | 연차 | 비고*', '1년 미만 | 11일 | 월 1일', '1~3년 | 15일 |', '3년 이상 | 20일 | 최대 25일'].join(
        '\n',
      ),
    );
    // The delimiter row never appears and no HTML leaks through.
    expect(result).not.toContain('---');
    expect(result).not.toContain('<');
  });

  it('renders inline bold, code and links inside cells through the Slack renderers', async () => {
    const markdown = [
      '| Field | Value |',
      '| --- | --- |',
      '| **bold** | `code` |',
      '| [Handbook](https://example.com/handbook) | plain |',
      '',
    ].join('\n');

    const result = await convertMarkdownToSlackText(markdown);

    expect(result).toBe(['*Field | Value*', '*bold* | `code`', 'Handbook | plain'].join('\n'));
  });

  it('does not double-wrap a header row that is already bold end to end', async () => {
    const markdown = ['| **A** | **B** |', '| --- | --- |', '| 1 | 2 |', ''].join('\n');

    const result = await convertMarkdownToSlackText(markdown);

    // Header cells carry their own `*`, so the row is left alone rather than
    // becoming `**A* | *B**`, which the `**x**` post-processing would mangle.
    expect(result).toBe(['*A* | *B*', '1 | 2'].join('\n'));
    expect(result).not.toContain('**');
  });

  it('renders empty cells as empty strings, keeping the column count visible', async () => {
    const markdown = ['| A | B | C |', '| --- | --- | --- |', '| 1 | | 3 |', '| | | |', '| 4 | 5 | 6 |', ''].join('\n');

    const result = await convertMarkdownToSlackText(markdown);

    expect(result).toBe(['*A | B | C*', '1 |  | 3', ' |  |', '4 | 5 | 6'].join('\n'));
  });

  it('keeps a paragraph before and a list after the table intact', async () => {
    const markdown = [
      '# Leave policy',
      '',
      'Annual leave accrues by tenure.',
      '',
      '| Tenure | Days |',
      '| --- | --- |',
      '| < 1y | 11 |',
      '| 1-3y | 15 |',
      '',
      '- Carry-over is capped.',
      '- Ask HR for exceptions.',
      '',
    ].join('\n');

    const result = await convertMarkdownToSlackText(markdown);

    expect(result).toBe(
      [
        'Annual leave accrues by tenure.',
        '',
        '*Tenure | Days*',
        '< 1y | 11',
        '1-3y | 15',
        '',
        '• Carry-over is capped.',
        '• Ask HR for exceptions.',
      ].join('\n'),
    );
  });

  it('renders two tables separated by a blank line', async () => {
    const markdown = [
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '| C | D |',
      '| --- | --- |',
      '| 3 | 4 |',
      '',
    ].join('\n');

    const result = await convertMarkdownToSlackText(markdown);

    expect(result).toBe(['*A | B*', '1 | 2', '', '*C | D*', '3 | 4'].join('\n'));
  });
});

describe('convertMarkdownToSlackText — behaviour without tables is unchanged', () => {
  it('drops the first heading and bolds later ones', async () => {
    const markdown = ['# Title', '', 'Body text.', '', '## Section', '', 'More text.', ''].join('\n');

    expect(await convertMarkdownToSlackText(markdown)).toBe(
      ['Body text.', '', '*Section*', '', 'More text.'].join('\n'),
    );
  });

  // The two cases below are pinned against the output of the pre-table
  // implementation, so a regression in the shared renderers shows up here.
  it('keeps paragraph markdown, lists as bullets and `**x**` folded to `*x*`', async () => {
    const markdown = [
      'See [the handbook](https://example.com) for **rules** and _notes_ and `code`.',
      '',
      '1. first',
      '2. second',
      '',
      '- alpha',
      '- beta',
      '',
    ].join('\n');

    expect(await convertMarkdownToSlackText(markdown)).toBe(
      [
        'See [the handbook](https://example.com) for *rules* and _notes_ and `code`.',
        '',
        '1. first',
        '2. second',
        '',
        '• alpha',
        '• beta',
      ].join('\n'),
    );
  });

  it('keeps fenced code blocks and horizontal rules', async () => {
    const markdown = ['Intro.', '', '```', 'const a = 1;', '```', '', '---', '', 'Outro.', ''].join('\n');

    expect(await convertMarkdownToSlackText(markdown)).toBe(
      ['Intro.', '', '```const a = 1;```', '---', 'Outro.'].join('\n'),
    );
  });
});
