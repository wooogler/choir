import { extractToc, slugifyHeading } from '../web/src/utils/docs';
import { inlineMarkdownToText, parseInlineMarkdown } from '../web/src/utils/inline-markdown';

/**
 * The document outline shows a heading's emphasis instead of the asterisks that
 * spell it. Two things have to hold for that to work: the runs must carry the
 * right styles, and the text of those runs must still be what the *rendered*
 * heading says — the viewer matches an outline entry to its heading by
 * slugifying the heading element's textContent.
 */

/** What the browser would report for the rendered heading, per CommonMark. */
function rendered(text: string): string {
  return text;
}

describe('parseInlineMarkdown', () => {
  it('splits bold and italic runs', () => {
    expect(parseInlineMarkdown('**Table of Contents**')).toEqual([{ bold: true, text: 'Table of Contents' }]);
    expect(parseInlineMarkdown('*My Teaching Load*')).toEqual([{ italic: true, text: 'My Teaching Load' }]);
    expect(parseInlineMarkdown('plain **bold** tail')).toEqual([
      { text: 'plain ' },
      { bold: true, text: 'bold' },
      { text: ' tail' },
    ]);
  });

  it('reads the triple marker as both, and strikethrough as its own run', () => {
    expect(parseInlineMarkdown('***all three***')).toEqual([{ bold: true, italic: true, text: 'all three' }]);
    expect(parseInlineMarkdown('~~struck~~')).toEqual([{ strike: true, text: 'struck' }]);
  });

  it('nests emphasis and keeps code spans', () => {
    expect(parseInlineMarkdown('**bold _and italic_**')).toEqual([
      { bold: true, text: 'bold ' },
      { bold: true, italic: true, text: 'and italic' },
    ]);
    expect(parseInlineMarkdown('run `pnpm test`')).toEqual([{ text: 'run ' }, { code: true, text: 'pnpm test' }]);
  });

  it('keeps a strong run that sits inside an emphasised one', () => {
    // Matching lazily to the next `*` would end the emphasis inside `**new**`,
    // leaving stray asterisks in the outline.
    expect(parseInlineMarkdown('*Draft: the **new** rail*')).toEqual([
      { italic: true, text: 'Draft: the ' },
      { bold: true, italic: true, text: 'new' },
      { italic: true, text: ' rail' },
    ]);
    expect(inlineMarkdownToText('*Draft: the **new** rail*')).toBe(rendered('Draft: the new rail'));
  });

  it('unwraps links and honours escapes', () => {
    expect(parseInlineMarkdown('[**DUB** Seminar](https://dub.uw.edu)')).toEqual([
      { bold: true, text: 'DUB' },
      { text: ' Seminar' },
    ]);
    expect(parseInlineMarkdown('literal \\*stars\\*')).toEqual([{ text: 'literal *stars*' }]);
    // The escaped marker must not be mistaken for the closing one.
    expect(inlineMarkdownToText('Use *a\\*b* here')).toBe(rendered('Use a*b here'));
  });

  it('drops images, which contribute nothing to a rendered heading', () => {
    // The alt text lives in an attribute, so a heading with an image reads —
    // and slugifies — as if the image were not there.
    expect(parseInlineMarkdown('**![](assets/561eb.png)**')).toEqual([]);
    expect(parseInlineMarkdown('**![Logo](assets/x.png)**')).toEqual([]);
    expect(inlineMarkdownToText('Status ![build passing](badge.svg)')).toBe(rendered('Status'));
  });

  it('leaves a destination markdown would not accept as literal text', () => {
    // A space in the destination is not a link in CommonMark, so the heading
    // renders verbatim and the label has to say the same thing.
    const heading = 'Read the [style guide](docs/style guide.md)';
    expect(inlineMarkdownToText(heading)).toBe(rendered(heading));
    expect(inlineMarkdownToText('[link](<a b.md>)')).toBe(rendered('link'));
    expect(inlineMarkdownToText('[t](x.md "title")')).toBe(rendered('t'));
  });

  it('strips a code span the way CommonMark does', () => {
    expect(parseInlineMarkdown('The ` code ` span')).toEqual([
      { text: 'The ' },
      { code: true, text: 'code' },
      { text: ' span' },
    ]);
    // One space each side is stripped, but a span that is only spaces is not.
    expect(inlineMarkdownToText('a` `b')).toBe(rendered('a b'));
    // And nothing inside a code span is markup.
    expect(parseInlineMarkdown('`code **not bold**`')).toEqual([{ code: true, text: 'code **not bold**' }]);
  });

  it('resolves the character references a renderer resolves', () => {
    // Google Docs exports carry these routinely.
    expect(inlineMarkdownToText('Team&nbsp;charter')).toBe(rendered('Team charter'));
    expect(inlineMarkdownToText('Q&amp;A')).toBe(rendered('Q&A'));
    expect(inlineMarkdownToText('&#65;&#x42;')).toBe(rendered('AB'));
    expect(inlineMarkdownToText('&unknownent;')).toBe('&unknownent;');
  });

  it('leaves unmatched markers alone', () => {
    expect(inlineMarkdownToText('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(inlineMarkdownToText('snake_case_name')).toBe('snake_case_name');
    expect(inlineMarkdownToText('unclosed **bold')).toBe('unclosed **bold');
  });

  it('stays fast on headings that are mostly markers', () => {
    // The bodies are unambiguous alternations, so there is no backtracking to
    // blow up on input like this.
    const started = Date.now();
    parseInlineMarkdown(`${'*'.repeat(200)}a`);
    parseInlineMarkdown(`*${'a\\'.repeat(400)}`);
    parseInlineMarkdown(`${'['.repeat(400)}x`);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('extractToc', () => {
  it('carries styled segments and slugs from the plain text', () => {
    const [item] = extractToc('## **Makeability Lab Handbook**\n');
    expect(item.label).toBe('Makeability Lab Handbook');
    expect(item.slug).toBe('makeability-lab-handbook');
    expect(item.segments).toEqual([{ bold: true, text: 'Makeability Lab Handbook' }]);
  });

  it('drops a heading that is only an image', () => {
    expect(extractToc('# ![](assets/561eb.png)\n')).toEqual([]);
    expect(extractToc('# ![Logo](assets/logo.png)\n')).toEqual([]);
  });

  it('gives a Korean heading a real anchor, like the server does', () => {
    // An ASCII-only slug left every CJK heading sharing the empty string, so
    // clicking one scrolled to whichever heading came first.
    const [first, second] = extractToc('## **배포 절차**\n\n## 온보딩\n');
    expect(first.slug).toBe('배포-절차');
    expect(second.slug).toBe('온보딩');
    expect(first.slug).toBe(slugifyHeading('배포 절차'));
  });

  it('slugs the same heading the same way the rendered document does', () => {
    const headings = [
      ['## **Makeability Lab Handbook**', 'Makeability Lab Handbook'],
      ['## *Draft: the **new** rail*', 'Draft: the new rail'],
      ['## Status ![build passing](badge.svg)', 'Status'],
      ['## Run `pnpm verify` first', 'Run pnpm verify first'],
      ['## [DUB Seminar](https://dub.uw.edu)', 'DUB Seminar'],
      ['## Q&amp;A', 'Q&A'],
    ];

    for (const [markdown, textContent] of headings) {
      const [item] = extractToc(`${markdown}\n`);
      expect(item.slug).toBe(slugifyHeading(textContent));
    }
  });
});
