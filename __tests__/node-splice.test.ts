import { parseMarkdownToTree, treeToMarkdown } from 'services/document/markdown';
import { applyNodeSplices } from 'services/document/node-splice';

/**
 * A Slack-driven update edits one node. Everything else in the file belongs to
 * whoever wrote it, and the point of splicing by offset is that those lines come
 * out the other side byte-identical.
 *
 * The second half of this file pins down what re-serializing the tree does
 * instead, because that is what the update path used to commit and it is the
 * reason the splice exists.
 */

const DOCUMENT = [
  '---',
  'title: Onboarding',
  '---',
  '',
  '# Onboarding',
  '',
  'Read this before your first week.',
  '',
  '1. Request an account',
  '2. Join the channel',
  '',
  '- top level',
  '  - nested item',
  '',
  '| Step | Owner |',
  '| --- | --- |',
  '| Account | IT |',
  '',
  '    indented code block',
  '',
  'Ask in #help if anything is unclear.',
  '',
].join('\n');

/** Byte range of the one paragraph a test wants to replace. */
function rangeOf(markdown: string, text: string): { start: number; end: number } {
  const start = markdown.indexOf(text);
  if (start < 0) throw new Error(`fixture does not contain ${JSON.stringify(text)}`);
  return { start, end: start + text.length };
}

describe('applyNodeSplices', () => {
  it('replaces one range and leaves every other byte alone', () => {
    const target = rangeOf(DOCUMENT, 'Read this before your first week.');
    const result = applyNodeSplices(DOCUMENT, [{ ...target, replacement: 'Read this in your first week.' }]);

    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.markdown).toBe(
      DOCUMENT.replace('Read this before your first week.', 'Read this in your first week.'),
    );

    // The constructs a tree round trip mangles, spelled out one at a time.
    expect(result.markdown).toContain('---\ntitle: Onboarding\n---');
    expect(result.markdown).toContain('1. Request an account\n2. Join the channel');
    expect(result.markdown).toContain('- top level\n  - nested item');
    expect(result.markdown).toContain('| Step | Owner |\n| --- | --- |');
    expect(result.markdown).toContain('    indented code block');
    expect(result.markdown.endsWith('\n')).toBe(true);
  });

  it('applies several edits to one document without shifting each other', () => {
    const first = rangeOf(DOCUMENT, 'Read this before your first week.');
    const second = rangeOf(DOCUMENT, 'Ask in #help if anything is unclear.');

    const result = applyNodeSplices(DOCUMENT, [
      // Deliberately in ascending order: the implementation is what has to sort.
      { ...first, replacement: 'A much longer opening paragraph than the one it replaces.' },
      { ...second, replacement: 'Ask.' },
    ]);

    expect(result.applied).toHaveLength(2);
    expect(result.markdown).toContain('A much longer opening paragraph than the one it replaces.');
    expect(result.markdown).toContain('Ask.');
    expect(result.markdown).toContain('1. Request an account');
  });

  it('refuses a range that overlaps one it has already taken', () => {
    // A list and one of its items are both addressable nodes, so a batch really
    // can carry a range inside another range.
    const list = rangeOf(DOCUMENT, '- top level\n  - nested item');
    const item = rangeOf(DOCUMENT, '  - nested item');

    const result = applyNodeSplices(DOCUMENT, [
      { ...list, replacement: '- rewritten list', label: 'list' },
      { ...item, replacement: '  - rewritten item', label: 'item' },
    ]);

    expect(result.applied.map((splice) => splice.label)).toEqual(['list']);
    expect(result.skipped).toEqual([{ splice: expect.objectContaining({ label: 'item' }), reason: 'overlap' }]);
    expect(result.markdown).toContain('- rewritten list');
    expect(result.markdown).not.toContain('rewritten item');
  });

  it('reports a range that does not fit the document instead of throwing', () => {
    const result = applyNodeSplices(DOCUMENT, [
      { start: 5, end: DOCUMENT.length + 40, replacement: 'x', label: 'past-the-end' },
      { start: -1, end: 4, replacement: 'y', label: 'negative' },
    ]);

    expect(result.markdown).toBe(DOCUMENT);
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['out-of-range', 'out-of-range']);
  });

  it('does nothing to a document with no edits', () => {
    expect(applyNodeSplices(DOCUMENT, []).markdown).toBe(DOCUMENT);
  });
});

describe('the offsets the splice relies on', () => {
  it('are on every block-level node the parser produces', () => {
    const tree = parseMarkdownToTree(DOCUMENT, 'onboarding.md');
    const blocks = [...tree.nodeMap.values()].filter((node) => node.position?.start?.offset !== undefined);

    expect(blocks.length).toBeGreaterThan(0);
    for (const node of blocks) {
      const start = node.position?.start?.offset as number;
      const end = node.position?.end?.offset as number;
      // The offsets must address the source exactly, or a splice writes into the
      // wrong place.
      expect(DOCUMENT.slice(start, end).length).toBe(end - start);
    }
  });

  it('survive being read back from the same tree twice', () => {
    const tree = parseMarkdownToTree(DOCUMENT, 'onboarding.md');
    const ids = [...tree.nodeMap.keys()];
    const first = ids.map((id) => tree.nodeMap.get(id)?.position?.start?.offset);
    const second = ids.map((id) => tree.nodeMap.get(id)?.position?.start?.offset);

    expect(second).toEqual(first);
  });
});

describe('re-serializing the tree, which is what the splice replaced', () => {
  it('rewrites lines nobody edited', () => {
    const round = treeToMarkdown(parseMarkdownToTree(DOCUMENT, 'onboarding.md'));

    // Recorded rather than asserted as desirable: this is the damage, and if a
    // later change to the serializer fixes any of it this test should be updated
    // deliberately rather than silently.
    expect(round).not.toBe(DOCUMENT);
    expect(round).not.toContain('1. Request an account');
    expect(round).not.toContain('  - nested item');
    expect(round).not.toContain('---\ntitle: Onboarding\n---');
    expect(round.endsWith('\n')).toBe(false);
  });
});
