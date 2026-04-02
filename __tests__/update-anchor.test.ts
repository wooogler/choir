import { applyAnchorReplacement, stripSnippetHeader, type UpdateAnchor } from 'services/document/update-anchor';

describe('update-anchor helpers', () => {
  describe('stripSnippetHeader', () => {
    it('removes qmd snippet headers', () => {
      const snippet = '@@ -12,3 @@ (11 before, 20 after)\nfirst line\nsecond line';

      expect(stripSnippetHeader(snippet)).toBe('first line\nsecond line');
    });

    it('keeps plain snippets unchanged', () => {
      expect(stripSnippetHeader('plain snippet')).toBe('plain snippet');
    });
  });

  describe('applyAnchorReplacement', () => {
    it('replaces the exact anchored text', () => {
      const markdown = ['# Guide', '', 'Alpha paragraph.', '', 'Beta paragraph.'].join('\n');
      const anchor: UpdateAnchor = {
        source: 'qmd',
        anchorId: 'qmd:guide.md:3:3',
        filePath: 'guide.md',
        snippet: 'Alpha paragraph.',
        originalText: 'Alpha paragraph.',
        startLine: 3,
        endLine: 3,
        focusLine: 3,
      };

      const result = applyAnchorReplacement(markdown, anchor, 'Updated alpha paragraph.');

      expect(result.success).toBe(true);
      expect(result.updatedMarkdown).toContain('Updated alpha paragraph.');
      expect(result.updatedMarkdown).not.toContain('Alpha paragraph.');
    });

    it('uses line proximity when the same text appears multiple times', () => {
      const markdown = [
        '# Guide',
        '',
        'Repeated line',
        '',
        'Middle section',
        '',
        'Repeated line',
        '',
        'Tail',
      ].join('\n');
      const anchor: UpdateAnchor = {
        source: 'qmd',
        anchorId: 'qmd:guide.md:7:7',
        filePath: 'guide.md',
        snippet: 'Repeated line',
        originalText: 'Repeated line',
        startLine: 7,
        endLine: 7,
        focusLine: 7,
      };

      const result = applyAnchorReplacement(markdown, anchor, 'Updated repeated line');

      expect(result.success).toBe(true);
      expect(result.updatedMarkdown).toContain('Middle section\n\nUpdated repeated line');
      expect(result.updatedMarkdown).toContain('\n\nRepeated line\n\nMiddle section');
    });
  });
});
