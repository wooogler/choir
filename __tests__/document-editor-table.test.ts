// A GFM table used to be classified as 'paragraph', so the edit prompt invited
// the model to append prose under it — and the 500-token budget truncated any
// table of moderate size. The caller replaces the whole block with the reply,
// so both failures landed in the commit.

const mockChat = jest.fn();
const mockStructured = jest.fn();
jest.mock('services/llm/completions', () => ({
  createChatCompletion: (...args: any[]) => mockChat(...args),
  createStructuredResponse: (...args: any[]) => mockStructured(...args),
}));

// The editor anonymizes knowledge before prompting; not under test here.
jest.mock('services/common/name-cache', () => ({
  anonymizeText: (text: string) => text,
}));

// The content-language policy would otherwise read the workspace store.
const mockContentLanguage = jest.fn();
jest.mock('services/i18n/resolve-locale', () => ({
  resolveContentLanguage: (...args: any[]) => mockContentLanguage(...args),
}));

import { detectExistingContentType, editMarkdownWithKnowledge } from 'services/llm/document-editor';

const PIPED_TABLE = `| Environment | Host | Owner |
| --- | --- | --- |
| staging | staging.example.com | Platform |
| production | example.com | Platform |`;

const BARE_TABLE = `Environment | Host | Owner
--- | --- | ---
staging | staging.example.com | Platform`;

const ALIGNED_TABLE = `| Environment | Host | Port |
| :--- | :---: | ---: |
| staging | staging.example.com | 443 |`;

beforeEach(() => {
  mockChat.mockReset();
  mockStructured.mockReset();
  mockContentLanguage.mockReset();
  mockContentLanguage.mockResolvedValue('follow-conversation');
});

describe('detectExistingContentType', () => {
  it('detects a table with leading and trailing pipes', () => {
    expect(detectExistingContentType(PIPED_TABLE)).toBe('table');
  });

  it('detects a table without leading or trailing pipes', () => {
    expect(detectExistingContentType(BARE_TABLE)).toBe('table');
  });

  it('detects a table whose delimiter row carries alignment colons', () => {
    expect(detectExistingContentType(ALIGNED_TABLE)).toBe('table');
  });

  it('ignores blank lines before and between the header and the delimiter row', () => {
    expect(detectExistingContentType(`\n\n${PIPED_TABLE}\n`)).toBe('table');
  });

  it('calls a pipe-bearing line with no delimiter row underneath a paragraph', () => {
    expect(detectExistingContentType('| Environment | Host |\nWe run staging and production.')).toBe('paragraph');
  });

  it('does not treat a horizontal rule under a pipe-bearing line as a table', () => {
    expect(detectExistingContentType('Use the `a | b` syntax.\n---\nMore prose.')).toBe('paragraph');
  });

  it('still detects bullet and numbered lists', () => {
    expect(detectExistingContentType('- Vacation is 14 days\n- Requests go to HR')).toBe('list');
    expect(detectExistingContentType('* Vacation is 14 days')).toBe('list');
    expect(detectExistingContentType('1. Vacation is 14 days')).toBe('list');
  });

  it('falls back to paragraph for prose and for empty input', () => {
    expect(detectExistingContentType('Vacation is 14 days per year.')).toBe('paragraph');
    expect(detectExistingContentType('')).toBe('paragraph');
  });
});

describe('editMarkdownWithKnowledge with a table', () => {
  const systemPrompt = () => mockChat.mock.calls[0][0][0].content as string;
  const options = () => mockChat.mock.calls[0][1] as { max_tokens: number };

  it('tells the model to preserve the table structure and gives it room to echo the whole table', async () => {
    mockChat.mockResolvedValue(PIPED_TABLE);
    await editMarkdownWithKnowledge(PIPED_TABLE, 'Staging moved to stg.example.com', { fileName: 'infra.md' });

    const prompt = systemPrompt();
    expect(prompt).toContain('Existing content type: table');
    expect(prompt).toContain('The existing content is a GFM markdown table.');
    expect(prompt).toContain('Keep the exact table structure');
    expect(prompt).toContain('the same header row, the same delimiter row, one row per line');
    expect(prompt).toContain('update that cell in place');
    expect(prompt).toContain('add new rows in the same column layout');
    expect(prompt).toContain('Never convert the table into prose or into a list');
    expect(prompt).toContain('Return the COMPLETE table');
    expect(prompt).not.toContain('add it in matching format: as additional paragraphs');

    expect(options().max_tokens).toBeGreaterThanOrEqual(1500);
  });

  it('keeps the list and paragraph wording unchanged, and never budgets less than 1500 tokens', async () => {
    mockChat.mockResolvedValue('- Vacation is 15 days');
    await editMarkdownWithKnowledge('- Vacation is 14 days', 'Vacation is 15 days', { fileName: 'hr.md' });
    expect(systemPrompt()).toContain('add it in matching format: as additional list items (- format)');
    expect(systemPrompt()).not.toContain('GFM markdown table');
    expect(options().max_tokens).toBeGreaterThanOrEqual(1500);

    mockChat.mockReset();
    mockChat.mockResolvedValue('Vacation is 15 days.');
    await editMarkdownWithKnowledge('Vacation is 14 days.', 'Vacation is 15 days', { fileName: 'hr.md' });
    expect(systemPrompt()).toContain('add it in matching format: as additional paragraphs');
  });

  it('scales the token budget with a long table instead of the old flat 500', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => `| row-${i} | host-${i}.example.com | Platform |`).join('\n');
    const longTable = `| Environment | Host | Owner |\n| --- | --- | --- |\n${rows}`;
    mockChat.mockResolvedValue(longTable);
    await editMarkdownWithKnowledge(longTable, 'row-3 moved hosts', { fileName: 'infra.md' });

    expect(options().max_tokens).toBeGreaterThan(1500);
    expect(options().max_tokens).toBeLessThanOrEqual(4000);
  });
});
