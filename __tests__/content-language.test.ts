// The workspace's content-language policy, and the prompt sentence it becomes.
//
// The `follow-conversation` sentences are asserted verbatim on purpose: that
// policy is what every workspace has until a manager changes it, so a reworded
// sentence there is a silent change to how every document gets written.

const mockResolve = jest.fn();
jest.mock('services/i18n/resolve-locale', () => ({
  resolveContentLanguage: (...args: any[]) => mockResolve(...args),
}));

import { contentLanguageDirective, getContentLanguagePolicy } from 'services/llm/content-language';

beforeEach(() => {
  mockResolve.mockReset();
});

describe('getContentLanguagePolicy', () => {
  it('returns the workspace policy', async () => {
    mockResolve.mockResolvedValue('ko');
    expect(await getContentLanguagePolicy('T1')).toBe('ko');
    expect(mockResolve).toHaveBeenCalledWith('T1');
  });

  it('defaults to follow-conversation without a workspace, and never asks the store', async () => {
    expect(await getContentLanguagePolicy(undefined)).toBe('follow-conversation');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('falls back to follow-conversation when the lookup fails', async () => {
    mockResolve.mockRejectedValue(new Error('no database'));
    expect(await getContentLanguagePolicy('T1')).toBe('follow-conversation');
  });
});

describe('contentLanguageDirective, following the conversation', () => {
  it('reproduces the knowledge-extractor sentence byte-for-byte', () => {
    expect(contentLanguageDirective('follow-conversation', { source: 'conversation' })).toBe(
      '- Write in the SAME language as the conversation. If the conversation is in Korean, write the output in Korean.',
    );
  });

  it('reproduces the three knowledge sentences byte-for-byte', () => {
    expect(
      contentLanguageDirective('follow-conversation', {
        source: 'knowledge',
        subject: 'the initial content',
        followSuffix: '.',
      }),
    ).toBe('- Write the initial content in the same language as the knowledge.');

    expect(
      contentLanguageDirective('follow-conversation', {
        source: 'knowledge',
        subject: 'the section title and content',
      }),
    ).toBe('- Write the section title and content in the same language as the knowledge');

    expect(
      contentLanguageDirective('follow-conversation', {
        source: 'knowledge',
        followSuffix:
          ', unless the FILE/SECTION context is clearly in another language, in which case match the document',
      }),
    ).toBe(
      '- Write in the same language as the knowledge, unless the FILE/SECTION context is clearly in another language, in which case match the document',
    );
  });

  it('reproduces the merge sentence byte-for-byte', () => {
    expect(contentLanguageDirective('follow-conversation', { source: 'existing-content' })).toBe(
      "- Write the result in the language of the EXISTING content. If the knowledge is in a different language, translate it faithfully into the existing content's language; never leave mixed-language output",
    );
  });
});

describe('contentLanguageDirective, pinned to a language', () => {
  it('overrides the conversation', () => {
    expect(contentLanguageDirective('ko', { source: 'conversation' })).toBe(
      '- Write the output in Korean, regardless of the language of the conversation. Keep quoted names, URLs and code verbatim.',
    );
    expect(contentLanguageDirective('en', { source: 'conversation' })).toBe(
      '- Write the output in English, regardless of the language of the conversation. Keep quoted names, URLs and code verbatim.',
    );
  });

  it('overrides the knowledge, keeping whatever the call site says is being written', () => {
    expect(contentLanguageDirective('ko', { source: 'knowledge' })).toBe(
      '- Write the output in Korean, regardless of the language of the knowledge. Keep quoted names, URLs and code verbatim.',
    );
    expect(contentLanguageDirective('ko', { source: 'knowledge', subject: 'the initial content' })).toBe(
      '- Write the initial content in Korean, regardless of the language of the knowledge. Keep quoted names, URLs and code verbatim.',
    );
  });

  it('drops the follow-the-source caveats, which the fixed language outranks', () => {
    const directive = contentLanguageDirective('ko', {
      source: 'knowledge',
      followSuffix:
        ', unless the FILE/SECTION context is clearly in another language, in which case match the document',
    });
    expect(directive).not.toContain('FILE/SECTION');
  });

  it('lets matching existing content win, and says what to do when it does not match', () => {
    const directive = contentLanguageDirective('ko', { source: 'existing-content' });
    expect(directive).toContain('If the EXISTING content is already in Korean, keep its wording and style');
    expect(directive).toContain('if the existing content is in another language, write the merged result in Korean');
    expect(directive).toContain('Never leave mixed-language output.');
  });
});
