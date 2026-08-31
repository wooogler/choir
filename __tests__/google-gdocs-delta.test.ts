import { REPLICA_BANNER } from 'services/google/banner';
import { extractDelta } from 'services/google/gdocs-delta';

/**
 * The repository markdown, and the export Google produces from it: escaped
 * punctuation, hard-break spaces on list items, and no code fences.
 */
const SOURCE = ['# Guide', '', '1. First step', '2. Second step', '', 'Some prose here.', ''].join('\n');

const BASELINE = [
  REPLICA_BANNER,
  '',
  '# Guide',
  '',
  '1\\. First step  ',
  '2\\. Second step',
  '',
  'Some prose here.',
  '',
].join('\n');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('payload-a'),
]).toString('base64');

describe('extracting a Google Docs edit as repository markdown', () => {
  it('reports no change when the export matches the baseline', () => {
    const result = extractDelta({
      baseline: BASELINE,
      exported: BASELINE,
      sourceAtPush: SOURCE,
      currentSource: SOURCE,
    });

    expect(result.hasChanges).toBe(false);
    expect(result.merged).toBe(SOURCE);
    expect(result.conflicts).toEqual([]);
  });

  it('does not mistake the export dialect for an edit', () => {
    // The escaped `1\.` and the hard-break spaces exist only in the export. If
    // they leaked into the comparison, every document would look rewritten.
    const result = extractDelta({
      baseline: BASELINE,
      exported: BASELINE.replace('Some prose here.', 'Some prose here, extended.'),
      sourceAtPush: SOURCE,
      currentSource: SOURCE,
    });

    expect(result.merged).toContain('1. First step');
    expect(result.merged).not.toContain('1\\.');
    expect(result.merged).not.toMatch(/ {2}$/m);
  });

  it('carries an inserted paragraph back into the repository markdown', () => {
    const exported = BASELINE.replace('Some prose here.', 'Some prose here.\n\nA paragraph a person added.');

    const result = extractDelta({ baseline: BASELINE, exported, sourceAtPush: SOURCE, currentSource: SOURCE });

    expect(result.hasChanges).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toContain('A paragraph a person added.');
    expect(result.merged).toContain('# Guide');
  });

  it('unescapes only the lines a person wrote', () => {
    const exported = BASELINE.replace('Some prose here.', 'Some prose here.\n\n3\\. A third step');

    const result = extractDelta({ baseline: BASELINE, exported, sourceAtPush: SOURCE, currentSource: SOURCE });

    expect(result.merged).toContain('3. A third step');
  });

  it('leaves escapes the repository author wrote alone', () => {
    // Unescaping the whole document would turn a deliberate `\*literal\*` into
    // emphasis. Only edited lines are touched.
    const source = ['# Guide', '', 'A \\*literal\\* asterisk.', ''].join('\n');
    const baseline = [REPLICA_BANNER, '', '# Guide', '', 'A \\*literal\\* asterisk.', ''].join('\n');
    const exported = baseline.replace('# Guide', '# Guide Revised');

    const result = extractDelta({ baseline, exported, sourceAtPush: source, currentSource: source });

    expect(result.merged).toContain('A \\*literal\\* asterisk.');
    expect(result.merged).toContain('# Guide Revised');
  });

  it('merges the edit with an unrelated change made on GitHub since', () => {
    const exported = BASELINE.replace('Some prose here.', 'Some prose here, revised in Docs.');
    const currentSource = SOURCE.replace('# Guide', '# Guide (renamed on GitHub)');

    const result = extractDelta({ baseline: BASELINE, exported, sourceAtPush: SOURCE, currentSource });

    expect(result.conflicts).toEqual([]);
    expect(result.merged).toContain('# Guide (renamed on GitHub)');
    expect(result.merged).toContain('Some prose here, revised in Docs.');
  });

  it('raises a conflict when both sides changed the same line', () => {
    const exported = BASELINE.replace('Some prose here.', 'Docs version of the line.');
    const currentSource = SOURCE.replace('Some prose here.', 'GitHub version of the line.');

    const result = extractDelta({ baseline: BASELINE, exported, sourceAtPush: SOURCE, currentSource });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].reason).toBe('merge');
    // The repository's text is kept; the person's version is surfaced, not applied.
    expect(result.merged).toContain('GitHub version of the line.');
    expect(result.conflicts[0].incoming.join('\n')).toContain('Docs version of the line.');
  });

  describe('code blocks', () => {
    const codeSource = [
      '# Guide',
      '',
      '```ts',
      'const answer = 42;',
      'export default answer;',
      '```',
      '',
      'Trailing prose.',
      '',
    ].join('\n');

    // Fences are gone and each line became its own paragraph.
    const codeBaseline = [
      REPLICA_BANNER,
      '',
      '# Guide',
      '',
      'const answer \\= 42;',
      '',
      'export default answer;',
      '',
      'Trailing prose.',
      '',
    ].join('\n');

    it('escalates an edit inside a code block to a conflict', () => {
      // The export cannot say whether the person meant code or prose, so this is
      // never merged automatically.
      const exported = codeBaseline.replace('const answer \\= 42;', 'const answer \\= 43;');

      const result = extractDelta({
        baseline: codeBaseline,
        exported,
        sourceAtPush: codeSource,
        currentSource: codeSource,
      });

      expect(result.conflicts.map((c) => c.reason)).toContain('code-block');
      expect(result.merged).toContain('const answer = 42;');
      expect(result.merged).toContain('```ts');
    });

    it('still merges an edit outside the code block', () => {
      const exported = codeBaseline.replace('Trailing prose.', 'Trailing prose, edited.');

      const result = extractDelta({
        baseline: codeBaseline,
        exported,
        sourceAtPush: codeSource,
        currentSource: codeSource,
      });

      expect(result.conflicts).toEqual([]);
      expect(result.merged).toContain('Trailing prose, edited.');
      expect(result.merged).toContain('```ts');
    });
  });

  describe('images', () => {
    const withImage = (payload: string, label = 'image1') =>
      [
        REPLICA_BANNER,
        '',
        '# Guide',
        '',
        `![A picture][${label}]`,
        '',
        `[${label}]: <data:image/png;base64,${payload}>`,
      ].join('\n');

    it('ignores an unchanged image even when its label is renumbered', () => {
      // Docs numbers image labels positionally, so inserting one renumbers the
      // rest and every later image would look changed.
      const baseline = withImage(PNG, 'image1');
      const exported = withImage(PNG, 'image7');

      const result = extractDelta({
        baseline,
        exported,
        sourceAtPush: '# Guide\n\n![A picture](assets/a.png)\n',
        currentSource: '# Guide\n\n![A picture](assets/a.png)\n',
      });

      expect(result.hasChanges).toBe(false);
      expect(result.newAssets).toEqual([]);
    });

    it('collects an image a person added', () => {
      const baseline = [REPLICA_BANNER, '', '# Guide', ''].join('\n');
      const exported = withImage(PNG);

      const result = extractDelta({
        baseline,
        exported,
        sourceAtPush: '# Guide\n',
        currentSource: '# Guide\n',
      });

      expect(result.newAssets).toHaveLength(1);
      expect(result.newAssets[0].contentType).toBe('image/png');
      expect(result.newAssets[0].extension).toBe('png');
    });

    it('refuses an SVG payload outright', () => {
      // It can carry script and would be served from the docs origin, which
      // holds the session cookie that authorises commits.
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString(
        'base64',
      );
      const exported = [REPLICA_BANNER, '', '# Guide', '', `[image1]: <data:image/svg+xml;base64,${svg}>`].join('\n');

      const result = extractDelta({
        baseline: [REPLICA_BANNER, '', '# Guide', ''].join('\n'),
        exported,
        sourceAtPush: '# Guide\n',
        currentSource: '# Guide\n',
      });

      expect(result.newAssets).toEqual([]);
      expect(result.rejectedAssets[0].reason).toMatch(/not a PNG/);
    });

    it('refuses a payload whose bytes do not match its declared type', () => {
      const html = Buffer.from('<html><body>not an image</body></html>').toString('base64');
      const exported = [REPLICA_BANNER, '', '# Guide', '', `[image1]: <data:image/png;base64,${html}>`].join('\n');

      const result = extractDelta({
        baseline: [REPLICA_BANNER, '', '# Guide', ''].join('\n'),
        exported,
        sourceAtPush: '# Guide\n',
        currentSource: '# Guide\n',
      });

      expect(result.newAssets).toEqual([]);
      expect(result.rejectedAssets).toHaveLength(1);
    });

    it('refuses a payload over the size limit before decoding it', () => {
      const huge = 'A'.repeat(15 * 1024 * 1024);
      const exported = [REPLICA_BANNER, '', '# Guide', '', `[image1]: <data:image/png;base64,${huge}>`].join('\n');

      const result = extractDelta({
        baseline: [REPLICA_BANNER, '', '# Guide', ''].join('\n'),
        exported,
        sourceAtPush: '# Guide\n',
        currentSource: '# Guide\n',
      });

      expect(result.newAssets).toEqual([]);
      expect(result.rejectedAssets[0].reason).toMatch(/10MB/);
    });
  });

  it('treats a wholesale deletion as a real change', () => {
    const result = extractDelta({
      baseline: BASELINE,
      exported: `${REPLICA_BANNER}\n\n`,
      sourceAtPush: SOURCE,
      currentSource: SOURCE,
    });

    expect(result.hasChanges).toBe(true);
  });
});
