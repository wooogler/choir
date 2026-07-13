import {
  sectionPathToOriginalPath,
  splitMarkdownToItems,
  stripItemHeadingPrefix,
} from 'services/document/markdown-section-splitter';

describe('markdown section splitter', () => {
  describe('splitMarkdownToItems', () => {
    it('splits paragraphs, list items, and code blocks into heading-scoped items', () => {
      const markdown = [
        '# Guide',
        '',
        'Intro paragraph.',
        '',
        '## Setup',
        '',
        '- Install dependencies',
        '- Run the app',
        '',
        '```ts',
        'const ready = true;',
        '```',
      ].join('\n');

      const items = splitMarkdownToItems(markdown, 'guide');

      expect(items).toEqual([
        {
          index: 0,
          heading: 'Guide',
          content: '# Guide\n\nIntro paragraph.',
        },
        {
          index: 1,
          heading: 'Setup',
          content: '# Setup\n\n- Install dependencies',
        },
        {
          index: 2,
          heading: 'Setup',
          content: '# Setup\n\n- Run the app',
        },
        {
          index: 3,
          heading: 'Setup',
          content: '# Setup\n\n```ts\nconst ready = true;\n```',
        },
      ]);
    });

    it('falls back to a single item when no splittable nodes exist', () => {
      expect(splitMarkdownToItems('', 'empty')).toEqual([
        {
          index: 0,
          heading: 'empty',
          content: '',
        },
      ]);
    });
  });

  describe('stripItemHeadingPrefix', () => {
    it('removes the synthetic heading prefix from section files', () => {
      expect(stripItemHeadingPrefix('# Setup\n\n- Install dependencies')).toBe('- Install dependencies');
    });
  });

  describe('sectionPathToOriginalPath', () => {
    // Section dirs keep the doc's .md extension (sections/<path.md>/<index>.md),
    // so recovering the original path just drops the trailing /<index>.md.
    it('maps top-level section files back to their original markdown file', () => {
      expect(sectionPathToOriginalPath('policies.md/0.md')).toBe('policies.md');
    });

    it('maps nested section files back to their original markdown file', () => {
      expect(sectionPathToOriginalPath('docs/guide.md/3.md')).toBe('docs/guide.md');
    });

    it('normalizes Windows-style separators', () => {
      expect(sectionPathToOriginalPath('docs\\guide.md\\3.md')).toBe('docs/guide.md');
    });

    it('distinguishes a file x.md from a document under a directory x/', () => {
      // Regression: the two used to both map to sections/x and collide.
      expect(sectionPathToOriginalPath('x.md/0.md')).toBe('x.md');
      expect(sectionPathToOriginalPath('x/foo.md/0.md')).toBe('x/foo.md');
    });
  });
});
