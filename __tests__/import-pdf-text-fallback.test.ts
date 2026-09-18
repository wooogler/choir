import type { PdfInspection, PdfLine } from 'services/import/sources/pdf/inspect';
import { pageFurnitureFilter, textFallbackMarkdown } from 'services/import/sources/pdf/text-fallback';

/** Lays lines down the page at a fixed leading so the y gaps are predictable. */
function page(lines: Array<{ text: string; height?: number; gap?: number }>): PdfLine[] {
  let y = 700;
  return lines.map((line, index) => {
    const height = line.height ?? 10;
    if (index > 0) y -= line.gap ?? height * 1.2;
    return { text: line.text, height, y };
  });
}

function inspection(pageLines: PdfLine[][]): PdfInspection {
  return {
    pages: pageLines.length,
    pageTexts: pageLines.map((lines) => lines.map((line) => line.text).join('\n')),
    pageLines,
    textPages: pageLines.map((_, index) => index + 1),
    scannedPages: [],
    imagePages: [],
    blankPages: [],
  };
}

describe('pageFurnitureFilter', () => {
  const pages = [1, 2, 3, 4].map((n) =>
    page([
      { text: 'ACME Internal — Confidential' },
      { text: `Body line ${n} that only appears on this one page of the document.` },
      { text: `Page ${n} of 4` },
    ]),
  );

  it('recognises a repeated header and a page number, and nothing else', () => {
    const isFurniture = pageFurnitureFilter(pages);
    expect(isFurniture('ACME Internal — Confidential')).toBe(true);
    expect(isFurniture('Page 2 of 4')).toBe(true);
    expect(isFurniture('7')).toBe(true);
    expect(isFurniture('Body line 2 that only appears on this one page of the document.')).toBe(false);
  });

  it('does not mistake a numbered body line for a footer', () => {
    // These differ only in a digit, so digit-masked matching would call them
    // furniture — and stripping real content from the source would inflate the
    // fidelity score instead of lowering it.
    const numbered = [1, 2, 3, 4].map((n) =>
      page([
        { text: 'ACME Internal — Confidential' },
        { text: `Section ${n} applies to every employee of the company without exception.` },
        { text: `Page ${n}` },
      ]),
    );
    const isFurniture = pageFurnitureFilter(numbered);

    expect(isFurniture('Section 2 applies to every employee of the company without exception.')).toBe(false);
    expect(isFurniture('ACME Internal — Confidential')).toBe(true);
    expect(isFurniture('Page 2')).toBe(true);
  });

  it('finds no furniture in a document too short to repeat anything', () => {
    const isFurniture = pageFurnitureFilter([page([{ text: 'A single page of text.' }])]);
    expect(isFurniture('A single page of text.')).toBe(false);
  });
});

describe('textFallbackMarkdown', () => {
  it('sizes headings off the dominant body height', () => {
    const markdown = textFallbackMarkdown(
      inspection([
        page([
          { text: 'Employee Handbook', height: 22 },
          { text: 'Working hours', height: 14 },
          { text: 'The standard working week is thirty-eight hours long.' },
          { text: 'Overtime is approved in advance by the team lead.' },
        ]),
      ]),
      'Fallback title',
    );

    expect(markdown).toContain('# Employee Handbook');
    expect(markdown).toContain('## Working hours');
    expect(markdown).not.toContain('# The standard working week');
  });

  it('prepends the given title when the document does not open with one', () => {
    const markdown = textFallbackMarkdown(
      inspection([page([{ text: 'Just some body text on its own.' }, { text: 'And a second line of it.' }])]),
      'Onboarding',
    );
    expect(markdown.startsWith('# Onboarding\n')).toBe(true);
  });

  it('keeps exactly one top-level heading', () => {
    const markdown = textFallbackMarkdown(
      inspection([
        page([
          { text: 'First part', height: 22 },
          { text: 'Body text that establishes the dominant height here.' },
          { text: 'Second part', height: 22 },
          { text: 'More body text at the ordinary size for this document.' },
        ]),
      ]),
      'Fallback title',
    );

    expect(markdown.match(/^# /gm)).toHaveLength(1);
    expect(markdown).toContain('# First part');
    expect(markdown).toContain('## Second part');
  });

  it('joins tight lines into a paragraph and breaks on a wide gap', () => {
    const markdown = textFallbackMarkdown(
      inspection([
        page([
          { text: 'The first sentence of the paragraph runs on' },
          { text: 'to a second line without a break.' },
          { text: 'A new paragraph begins after the wide gap.', gap: 40 },
        ]),
      ]),
      'Notes',
    );

    expect(markdown).toContain('The first sentence of the paragraph runs on to a second line without a break.');
    expect(markdown).toContain('\n\nA new paragraph begins after the wide gap.');
  });

  it('keeps bullets and numbered items as list items', () => {
    const markdown = textFallbackMarkdown(
      inspection([
        page([
          { text: 'Checklist items follow below in the usual order.' },
          { text: '• Sign the handbook' },
          { text: '· Collect the laptop' },
          { text: '1. Book the induction' },
          { text: '2) Meet the team' },
        ]),
      ]),
      'Checklist',
    );

    expect(markdown).toContain('- Sign the handbook');
    expect(markdown).toContain('- Collect the laptop');
    expect(markdown).toContain('1. Book the induction');
    expect(markdown).toContain('2. Meet the team');
    // Adjacent items stay adjacent so they render as one list.
    expect(markdown).toContain('- Sign the handbook\n- Collect the laptop');
  });

  it('drops running headers, footers and bare page numbers', () => {
    const bodies = [
      'The register records every request and the date it was approved.',
      'Managers keep the signed copy for as long as the policy requires.',
      'An extension must be requested in writing before the period ends.',
      'Nothing in this section overrides the retention schedule above.',
    ];
    const body = (n: number) => bodies[n - 1];
    const markdown = textFallbackMarkdown(
      inspection([
        page([{ text: 'ACME Internal — Confidential' }, { text: body(1) }, { text: '1' }]),
        page([{ text: 'ACME Internal — Confidential' }, { text: body(2) }, { text: '2' }]),
        page([{ text: 'ACME Internal — Confidential' }, { text: body(3) }, { text: 'Page 3' }]),
        page([{ text: 'ACME Internal — Confidential' }, { text: body(4) }, { text: '- 4 -' }]),
      ]),
      'Handbook',
    );

    expect(markdown).not.toContain('Confidential');
    expect(markdown).not.toMatch(/^Page 3$/m);
    expect(markdown).not.toMatch(/^- 4 -$/m);
    expect(markdown).toContain(body(2));
  });

  it('keeps a header that only appears on one page of a short document', () => {
    const markdown = textFallbackMarkdown(
      inspection([page([{ text: 'A one-off line that must survive.' }]), page([{ text: 'Another page of text.' }])]),
      'Short',
    );
    expect(markdown).toContain('A one-off line that must survive.');
  });

  it('escapes a body line that would otherwise read as markdown structure', () => {
    const markdown = textFallbackMarkdown(
      inspection([
        page([
          { text: 'The generated file opens with a comment line:' },
          { text: '# This file was generated automatically. Do not edit.', gap: 40 },
          { text: '> not a quotation either', gap: 40 },
        ]),
      ]),
      'Notes',
    );

    expect(markdown).toContain('\\# This file was generated automatically.');
    expect(markdown).toContain('\\> not a quotation either');
    expect(markdown.match(/^# /gm)).toHaveLength(1);
  });

  it('produces just the title for an empty document', () => {
    expect(textFallbackMarkdown(inspection([[]]), 'Empty')).toBe('# Empty\n');
  });
});
