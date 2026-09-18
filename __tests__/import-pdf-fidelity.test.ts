import { fidelityScore, stripMarkdownSyntax } from 'services/import/sources/pdf/fidelity';

describe('stripMarkdownSyntax', () => {
  it('drops markup but keeps the words', () => {
    const stripped = stripMarkdownSyntax('## Heading\n\n- a **bold** item\n- [a link](https://example.com/page)\n');
    expect(stripped).toContain('Heading');
    expect(stripped).toContain('bold');
    expect(stripped).toContain('a link');
    expect(stripped).not.toContain('https://example.com/page');
    expect(stripped).not.toContain('**');
  });

  it('drops fenced code and table pipes', () => {
    const stripped = stripMarkdownSyntax('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n');
    expect(stripped).not.toContain('|');
    expect(stripped).not.toContain('const x');
    expect(stripped).toContain('1');
  });
});

describe('fidelityScore', () => {
  const source = 'The retention period for onboarding records is three years from the date of hire.';

  it('scores an exact transcription at 1', () => {
    expect(fidelityScore(source, source)).toBe(1);
  });

  it('ignores markdown the model added around the same words', () => {
    const markdown =
      '# Retention\n\n**The retention period** for onboarding records is *three years* from the date of hire.\n';
    expect(fidelityScore(source, markdown)).toBe(1);
  });

  it('ignores whitespace, case and re-wrapping', () => {
    const markdown = 'the RETENTION period for onboarding\nrecords is three years from the\ndate of hire.';
    expect(fidelityScore(source, markdown)).toBe(1);
  });

  it('only loses the grams that straddle a moved cell boundary', () => {
    const table =
      '| Document name | Owning team |\n| --- | --- |\n| Onboarding checklist | People Operations |\n| Security review log | Platform Engineering |\n';
    const reordered =
      '| Owning team | Document name |\n| --- | --- |\n| People Operations | Onboarding checklist |\n| Platform Engineering | Security review log |\n';
    // Every cell survives; only the joins between them move.
    expect(fidelityScore(stripMarkdownSyntax(table), reordered)).toBeGreaterThan(0.75);
  });

  it('stays above the warning threshold when a table inside a document is reordered', () => {
    // Which is what matters: a real document is mostly prose, so the handful of
    // boundary grams a reordered table costs does not raise a false warning.
    const prose = `${source} Managers may request an extension in writing, and the extension is recorded in the same register as the original request.`;
    const table = '| Document name | Owning team |\n| Onboarding checklist | People Operations |\n';
    const reordered = '| Owning team | Document name |\n| People Operations | Onboarding checklist |\n';
    const score = fidelityScore(`${prose}\n${stripMarkdownSyntax(table)}`, `${prose}\n${reordered}`);
    expect(score).toBeGreaterThan(0.85);
  });

  it('scores a summary far below the threshold', () => {
    const summary = '# Retention\n\nRecords are kept for a while.\n';
    expect(fidelityScore(source, summary)).toBeLessThan(0.4);
  });

  it('penalises a partial transcription proportionally', () => {
    const half = 'The retention period for onboarding records is';
    const score = fidelityScore(source, half);
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.8);
  });

  it('skips the check when there is no source text to compare', () => {
    expect(fidelityScore('', '# Anything')).toBe(1);
    expect(fidelityScore('  \n ', '# Anything')).toBe(1);
    expect(fidelityScore('abc', '')).toBe(1);
  });

  it('treats full-width and compatibility forms as equal (NFKC)', () => {
    expect(fidelityScore('ＲＥＰＯＲＴ 2026', 'REPORT 2026')).toBe(1);
  });

  it('works on non-latin text', () => {
    const korean = '문서 보존 기간은 입사일로부터 3년입니다.';
    expect(fidelityScore(korean, `## 보존\n\n${korean}\n`)).toBe(1);
    expect(fidelityScore(korean, '보존 기간 안내')).toBeLessThan(0.5);
  });
});
