// The Responses API is the only thing that knows a reply was cut off by the
// output budget; the table editor's shape guard cannot tell a truncated table
// from a deliberately shorter one, so the flag has to come through the wrapper.

const mockCreate = jest.fn();
jest.mock('services/llm/openai-client-factory', () => ({
  getOpenAIClient: () => ({ responses: { create: mockCreate } }),
  invalidateClientCache: jest.fn(),
}));

jest.mock('services/llm/llm-config', () => ({
  resolveLLMConfig: jest.fn(async () => ({ apiKey: 'sk-test', model: 'gpt-test' })),
}));

jest.mock('services/common/name-cache', () => ({
  anonymizeText: (text: string) => text,
  deAnonymizeText: (text: string) => text,
}));

import { createChatCompletion, createChatCompletionWithMeta } from 'services/llm/completions';

beforeEach(() => {
  mockCreate.mockReset();
});

describe('createChatCompletionWithMeta', () => {
  it('flags a reply the API cut off at max_output_tokens', async () => {
    mockCreate.mockResolvedValue({
      output_text: '| a | b |\n| --- | --- |\n| 1 | ',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });

    const result = await createChatCompletionWithMeta([{ role: 'user', content: 'hi' }]);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('| a | b |\n| --- | --- |\n| 1 | ');
  });

  it('does not flag a completed reply', async () => {
    mockCreate.mockResolvedValue({
      output_text: 'all done',
      status: 'completed',
      incomplete_details: null,
    });

    const result = await createChatCompletionWithMeta([{ role: 'user', content: 'hi' }]);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('all done');
  });

  it('does not flag an incomplete reply stopped by the content filter', async () => {
    mockCreate.mockResolvedValue({
      output_text: 'partial',
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
    });

    const result = await createChatCompletionWithMeta([{ role: 'user', content: 'hi' }]);
    expect(result.truncated).toBe(false);
  });

  it('leaves createChatCompletion returning just the text', async () => {
    mockCreate.mockResolvedValue({
      output_text: 'all done',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });

    expect(await createChatCompletion([{ role: 'user', content: 'hi' }])).toBe('all done');
  });
});
