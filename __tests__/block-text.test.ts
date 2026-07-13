import { SLACK_SECTION_TEXT_LIMIT, buildSectionBlocks, chunkTextForBlocks } from '../services/slack/block-text';

describe('chunkTextForBlocks', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkTextForBlocks('hello')).toEqual(['hello']);
  });

  it('returns [] for empty text', () => {
    expect(chunkTextForBlocks('')).toEqual([]);
  });

  it('keeps every chunk within the section limit', () => {
    const long = 'word '.repeat(2000); // ~10000 chars
    const chunks = chunkTextForBlocks(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_LIMIT);
    }
  });

  it('preserves all the words across chunks', () => {
    const long = Array.from({ length: 1500 }, (_, i) => `w${i}`).join(' ');
    const rejoined = chunkTextForBlocks(long).join(' ');
    // No word is lost (order preserved, only whitespace at boundaries changes).
    expect(rejoined.split(/\s+/).filter(Boolean)).toEqual(long.split(' '));
  });

  it('prefers to break on a newline boundary', () => {
    const line = `${'a'.repeat(2000)}\n${'b'.repeat(2000)}`;
    const chunks = chunkTextForBlocks(line);
    expect(chunks[0]).toBe('a'.repeat(2000));
    expect(chunks[1]).toBe('b'.repeat(2000));
  });

  it('hard-splits a single token longer than the limit', () => {
    const token = 'x'.repeat(SLACK_SECTION_TEXT_LIMIT + 500);
    const chunks = chunkTextForBlocks(token);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(SLACK_SECTION_TEXT_LIMIT);
    expect(chunks.join('').length).toBe(token.length);
  });
});

describe('buildSectionBlocks', () => {
  it('puts the block_id only on the first block', () => {
    const long = 'word '.repeat(2000);
    const blocks = buildSectionBlocks(long, 'answer-block');
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks[0].block_id).toBe('answer-block');
    expect(blocks[1].block_id).toBeUndefined();
    for (const b of blocks) {
      expect((b.text as { text: string }).text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_LIMIT);
    }
  });

  it('returns a single section block for short text', () => {
    const blocks = buildSectionBlocks('hi', 'id1');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'section', block_id: 'id1' });
  });
});
