// A GFM table used to be classified as 'paragraph', so the edit prompt invited
// the model to append prose under it — and the 500-token budget truncated any
// table of moderate size. The caller replaces the whole block with the reply,
// so both failures landed in the commit.

// `enhanceExistingContent` needs the API's truncation flag alongside the text,
// so it calls `createChatCompletionWithMeta`; `mockChat` resolves either a bare
// string (the common case) or `{ text, truncated }`.
const mockChat = jest.fn();
const mockStructured = jest.fn();
jest.mock('services/llm/completions', () => ({
  createChatCompletion: async (...args: any[]) => {
    const result = await mockChat(...args);
    return typeof result === 'string' ? result : result?.text;
  },
  createChatCompletionWithMeta: async (...args: any[]) => {
    const result = await mockChat(...args);
    return typeof result === 'string' ? { text: result, truncated: false } : result;
  },
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

import { detectExistingContentType, editMarkdownWithKnowledge, validateTableEdit } from 'services/llm/document-editor';

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
    expect(prompt).toContain('Remove a row only when the knowledge says that entry no longer applies');
    expect(prompt).toContain('Return the COMPLETE table — every row that still applies plus your changes');
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

// The prompt asking for the whole table back is only an instruction; the caller
// commits whatever comes out, so the reply is re-checked against the original.
describe('validateTableEdit', () => {
  const expectFail = (original: string, candidate: string) => {
    const result = validateTableEdit(original, candidate);
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.reason;
  };

  it('accepts an edit that changes a cell', () => {
    const candidate = PIPED_TABLE.replace('staging.example.com', 'stg.example.com');
    expect(validateTableEdit(PIPED_TABLE, candidate)).toEqual({ ok: true });
  });

  it('accepts added rows', () => {
    const candidate = `${PIPED_TABLE}\n| sandbox | sandbox.example.com | Platform |`;
    expect(validateTableEdit(PIPED_TABLE, candidate)).toEqual({ ok: true });
  });

  it('accepts one short trailing paragraph after the table', () => {
    const candidate = `${PIPED_TABLE}\n\nAll hosts sit behind the shared load balancer.`;
    expect(validateTableEdit(PIPED_TABLE, candidate)).toEqual({ ok: true });
  });

  it('accepts a table without leading or trailing pipes on both sides', () => {
    const candidate = `${BARE_TABLE}\nproduction | example.com | Platform`;
    expect(validateTableEdit(BARE_TABLE, candidate)).toEqual({ ok: true });
  });

  it('counts an escaped pipe inside a cell as part of that cell', () => {
    const original = '| Command | Meaning |\n| --- | --- |\n| a \\| b | either a or b |';
    const candidate = '| Command | Meaning |\n| --- | --- |\n| a \\| b | either a or b |\n| c \\| d | either c or d |';
    expect(validateTableEdit(original, candidate)).toEqual({ ok: true });
  });

  it('rejects prose before the table', () => {
    const reason = expectFail(PIPED_TABLE, `Here is the updated table:\n\n${PIPED_TABLE}`);
    expect(reason).toContain('does not start with a table');
  });

  it('rejects a dropped column', () => {
    const candidate =
      '| Environment | Host |\n| --- | --- |\n| staging | staging.example.com |\n| production | example.com |';
    expect(expectFail(PIPED_TABLE, candidate)).toContain('2 columns but the original has 3');
  });

  it('rejects a renamed header cell', () => {
    const candidate = PIPED_TABLE.replace('| Owner |', '| Team |');
    expect(expectFail(PIPED_TABLE, candidate)).toContain('header row changed');
  });

  it('rejects reordered columns', () => {
    const candidate =
      '| Host | Environment | Owner |\n| --- | --- | --- |\n| staging.example.com | staging | Platform |\n| example.com | production | Platform |';
    expect(expectFail(PIPED_TABLE, candidate)).toContain('header row changed');
  });

  it('rejects a body row with the wrong cell count', () => {
    const candidate = `${PIPED_TABLE}\n| sandbox | sandbox.example.com |`;
    expect(expectFail(PIPED_TABLE, candidate)).toContain('cells but the table has 3 columns');
  });

  // Row deletion is legitimate: the knowledge can say an entry no longer
  // applies. Truncation is detected from the API's own flag instead.
  it('accepts a table with a row deleted', () => {
    const candidate =
      '| Environment | Host | Owner |\n| --- | --- | --- |\n| staging | staging.example.com | Platform |';
    expect(validateTableEdit(PIPED_TABLE, candidate)).toEqual({ ok: true });
  });

  it('rejects a reply the API flagged as truncated, however well-formed the table looks', () => {
    const candidate = PIPED_TABLE.replace('staging.example.com', 'stg.example.com');
    expect(validateTableEdit(PIPED_TABLE, candidate)).toEqual({ ok: true });

    const result = validateTableEdit(PIPED_TABLE, candidate, { truncated: true });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('cut off by the output token limit');
  });

  it('rejects a last row cut off before its closing pipe', () => {
    const candidate = `${PIPED_TABLE}\n| sandbox | sandbox.example.com | Platf`;
    expect(expectFail(PIPED_TABLE, candidate)).toContain('does not end with');
  });

  it('rejects a list after the table', () => {
    const candidate = `${PIPED_TABLE}\n\n- staging moved hosts\n- production is unchanged`;
    expect(expectFail(PIPED_TABLE, candidate)).toContain('content after the table');
  });

  it('rejects a heading after the table', () => {
    const candidate = `${PIPED_TABLE}\n\n## Notes`;
    expect(expectFail(PIPED_TABLE, candidate)).toContain('content after the table');
  });

  it('rejects two paragraphs after the table', () => {
    const candidate = `${PIPED_TABLE}\n\nFirst note.\n\nSecond note.`;
    expect(expectFail(PIPED_TABLE, candidate)).toContain('content after the table');
  });

  it('rejects the table rewritten as prose', () => {
    const candidate = 'Staging runs on stg.example.com and production on example.com, both owned by Platform.';
    expect(expectFail(PIPED_TABLE, candidate)).toContain('does not start with a table');
  });

  it('passes anything through when the original was not a table', () => {
    expect(validateTableEdit('Vacation is 14 days.', 'Vacation is 15 days.')).toEqual({ ok: true });
  });
});

describe('editMarkdownWithKnowledge table guard', () => {
  const VALID_EDIT = PIPED_TABLE.replace('staging.example.com', 'stg.example.com');
  const INVALID_EDIT = 'Staging now runs on stg.example.com.';
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns a valid reply after a single call', async () => {
    mockChat.mockResolvedValue(VALID_EDIT);
    const result = await editMarkdownWithKnowledge(PIPED_TABLE, 'Staging moved to stg.example.com', {
      fileName: 'infra.md',
    });

    expect(result).toBe(VALID_EDIT);
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it('retries once with the reason and returns the corrected table', async () => {
    mockChat.mockResolvedValueOnce(INVALID_EDIT).mockResolvedValueOnce(VALID_EDIT);
    const result = await editMarkdownWithKnowledge(PIPED_TABLE, 'Staging moved to stg.example.com', {
      fileName: 'infra.md',
    });

    expect(result).toBe(VALID_EDIT);
    expect(mockChat).toHaveBeenCalledTimes(2);

    const retryMessages = mockChat.mock.calls[1][0];
    expect(retryMessages).toHaveLength(mockChat.mock.calls[0][0].length + 1);
    const correction = retryMessages[retryMessages.length - 1];
    expect(correction.role).toBe('user');
    expect(correction.content).toContain('did not keep the table structure');
    expect(correction.content).toContain('does not start with a table');
    expect(correction.content).toContain('every row that still applies');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('retries with a doubled budget and a cut-off wording when the API flagged truncation', async () => {
    mockChat
      .mockResolvedValueOnce({ text: VALID_EDIT, truncated: true })
      .mockResolvedValueOnce({ text: VALID_EDIT, truncated: false });

    const result = await editMarkdownWithKnowledge(PIPED_TABLE, 'Staging moved to stg.example.com', {
      fileName: 'infra.md',
    });

    expect(result).toBe(VALID_EDIT);
    expect(mockChat).toHaveBeenCalledTimes(2);

    const firstBudget = mockChat.mock.calls[0][1].max_tokens as number;
    const retryBudget = mockChat.mock.calls[1][1].max_tokens as number;
    expect(retryBudget).toBe(Math.min(8000, firstBudget * 2));

    const retryMessages = mockChat.mock.calls[1][0];
    const correction = retryMessages[retryMessages.length - 1];
    expect(correction.content).toContain('cut off');
    expect(correction.content).toContain('output token limit');
  });

  it('accepts a deleted row in one call when the reply was not truncated', async () => {
    const withRowRemoved =
      '| Environment | Host | Owner |\n| --- | --- | --- |\n| staging | staging.example.com | Platform |';
    mockChat.mockResolvedValue({ text: withRowRemoved, truncated: false });

    const result = await editMarkdownWithKnowledge(PIPED_TABLE, 'Production was decommissioned', {
      fileName: 'infra.md',
    });

    expect(result).toBe(withRowRemoved);
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it('keeps the original content when the retry is malformed too', async () => {
    mockChat.mockResolvedValueOnce(INVALID_EDIT).mockResolvedValueOnce('Still prose about staging.');
    const result = await editMarkdownWithKnowledge(PIPED_TABLE, 'Staging moved to stg.example.com', {
      fileName: 'infra.md',
    });

    expect(result).toBe(PIPED_TABLE);
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it('keeps the original content when the retry comes back empty', async () => {
    mockChat.mockResolvedValueOnce(INVALID_EDIT).mockResolvedValueOnce('');
    const result = await editMarkdownWithKnowledge(PIPED_TABLE, 'Staging moved to stg.example.com', {
      fileName: 'infra.md',
    });

    expect(result).toBe(PIPED_TABLE);
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it('does not guard list content, however odd the reply', async () => {
    mockChat.mockResolvedValue('| Environment | Host |');
    const result = await editMarkdownWithKnowledge('- Vacation is 14 days', 'Vacation is 15 days', {
      fileName: 'hr.md',
    });

    expect(result).toBe('| Environment | Host |');
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it('returns the text of a list reply in one call, truncation flag and all', async () => {
    mockChat.mockResolvedValue({ text: '- Vacation is 15 days', truncated: true });
    const result = await editMarkdownWithKnowledge('- Vacation is 14 days', 'Vacation is 15 days', {
      fileName: 'hr.md',
    });

    expect(result).toBe('- Vacation is 15 days');
    expect(mockChat).toHaveBeenCalledTimes(1);
  });
});
