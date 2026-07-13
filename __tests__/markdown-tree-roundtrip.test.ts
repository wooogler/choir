import { parseMarkdownToTree, treeToMarkdown } from '../services/document/markdown-tree';

function roundTrip(markdown: string): string {
  return treeToMarkdown(parseMarkdownToTree(markdown, 'doc.md'));
}

describe('markdown tree round-trip preserves non-text nodes', () => {
  it('keeps an inline image inside a paragraph', () => {
    // Regression: images serialized to '' and were silently deleted on any
    // full-file re-commit (normalize, section apply, web save).
    const out = roundTrip('See the diagram ![alt text](assets/x.png) here.');
    expect(out).toContain('![alt text](assets/x.png)');
  });

  it('keeps an image title', () => {
    const out = roundTrip('![alt](assets/x.png "the title")');
    expect(out).toContain('![alt](assets/x.png "the title")');
  });

  it('keeps a standalone (block) image', () => {
    const out = roundTrip('![only image](assets/y.png)');
    expect(out).toContain('assets/y.png');
  });

  it('keeps a normal link (unchanged behavior)', () => {
    const out = roundTrip('Read the [guide](https://example.com/guide).');
    expect(out).toContain('[guide](https://example.com/guide)');
  });

  it('keeps a reference-style link and its definition', () => {
    const out = roundTrip('Read the [guide][g].\n\n[g]: https://example.com/guide');
    expect(out).toContain('[guide][g]');
    expect(out).toContain('[g]: https://example.com/guide');
  });

  it('keeps strikethrough (delete) text', () => {
    const out = roundTrip('This is ~~obsolete~~ current.');
    expect(out).toContain('~~obsolete~~');
  });

  it('does not lose surrounding text around an image', () => {
    const out = roundTrip('Before ![a](p.png) after.');
    expect(out).toContain('Before');
    expect(out).toContain('after.');
    expect(out).toContain('![a](p.png)');
  });
});
