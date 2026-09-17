jest.mock('../services/llm/completions', () => ({
  createChatCompletion: jest.fn(),
}));

import { createChatCompletion } from '@/services/llm/completions';
import {
  buildCrossLingualSearchQueries,
  isQueryTranslationEnabled,
  resetQueryTranslationCache,
  translateSearchQuery,
} from '@/services/llm/query-translation';
import { buildQmdLexQueryCandidates, buildQmdStructuredSearchQueries } from '@/services/retrieval/qmd-lex-search';

const mockedCompletion = createChatCompletion as jest.MockedFunction<typeof createChatCompletion>;

const KOREAN_QUESTION = '휴가는 어떻게 신청하나요?';
const ENGLISH_TRANSLATION = 'How do I request vacation leave?';

describe('query translation', () => {
  const originalFlag = process.env.QMD_QUERY_TRANSLATION;

  beforeEach(() => {
    mockedCompletion.mockReset();
    resetQueryTranslationCache();
    process.env.QMD_QUERY_TRANSLATION = '';
  });

  afterEach(() => {
    process.env.QMD_QUERY_TRANSLATION = originalFlag ?? '';
    jest.restoreAllMocks();
  });

  describe('the flag', () => {
    it('defaults to on and accepts the usual off spellings', () => {
      expect(isQueryTranslationEnabled()).toBe(true);
      for (const off of ['false', 'FALSE', '0', 'off']) {
        process.env.QMD_QUERY_TRANSLATION = off;
        expect(isQueryTranslationEnabled()).toBe(false);
      }
      process.env.QMD_QUERY_TRANSLATION = 'true';
      expect(isQueryTranslationEnabled()).toBe(true);
    });
  });

  describe('buildCrossLingualSearchQueries', () => {
    it('adds no query and calls no model when the question is already in the repository language', async () => {
      const queries = await buildCrossLingualSearchQueries({
        query: 'How do I request vacation days?',
        repositoryLanguage: 'en',
        workspaceId: 'T1',
      });

      expect(queries).toEqual(buildQmdStructuredSearchQueries('How do I request vacation days?', 2));
      expect(mockedCompletion).not.toHaveBeenCalled();
    });

    it('behaves exactly as before when the repository language is unknown', async () => {
      const queries = await buildCrossLingualSearchQueries({ query: KOREAN_QUESTION, workspaceId: 'T1' });

      expect(queries).toEqual(buildQmdStructuredSearchQueries(KOREAN_QUESTION, 2));
      expect(mockedCompletion).not.toHaveBeenCalled();
    });

    it('puts the translated vector query second and appends its lexical candidates', async () => {
      mockedCompletion.mockResolvedValue(ENGLISH_TRANSLATION);

      const queries = await buildCrossLingualSearchQueries({
        query: KOREAN_QUESTION,
        repositoryLanguage: 'en',
        workspaceId: 'T1',
      });

      // The asker's own words keep index 0, which QMD weights at 2.0.
      expect(queries[0]).toEqual({ type: 'vec', query: KOREAN_QUESTION });
      expect(queries[1]).toEqual({ type: 'vec', query: ENGLISH_TRANSLATION });
      expect(queries.filter((entry) => entry.type === 'vec')).toHaveLength(2);

      const lexQueries = queries.filter((entry) => entry.type === 'lex').map((entry) => entry.query);
      expect(lexQueries.slice(0, 2)).toEqual(buildQmdLexQueryCandidates(KOREAN_QUESTION).slice(0, 2));
      expect(lexQueries.slice(2)).toEqual(buildQmdLexQueryCandidates(ENGLISH_TRANSLATION).slice(0, 2));

      expect(mockedCompletion).toHaveBeenCalledTimes(1);
      const [, options] = mockedCompletion.mock.calls[0];
      expect(options).toMatchObject({ purpose: 'classification', temperature: 0, workspaceId: 'T1' });
      // A question can name a person, so anonymization must stay on.
      expect(options?.skipAnonymization).toBeUndefined();
    });

    it('translates an English question for a Korean repository too', async () => {
      mockedCompletion.mockResolvedValue('휴가 신청 방법');

      const queries = await buildCrossLingualSearchQueries({
        query: 'How do I request vacation days?',
        repositoryLanguage: 'ko',
        workspaceId: 'T1',
      });

      expect(queries[0]).toEqual({ type: 'vec', query: 'How do I request vacation days?' });
      expect(queries[1]).toEqual({ type: 'vec', query: '휴가 신청 방법' });
    });

    it('falls back to the original queries when the model fails', async () => {
      mockedCompletion.mockRejectedValue(new Error('model unavailable'));

      const queries = await buildCrossLingualSearchQueries({
        query: KOREAN_QUESTION,
        repositoryLanguage: 'en',
        workspaceId: 'T1',
      });

      expect(queries).toEqual(buildQmdStructuredSearchQueries(KOREAN_QUESTION, 2));
      expect(mockedCompletion).toHaveBeenCalledTimes(1);
    });

    it('falls back when the model returns nothing usable', async () => {
      mockedCompletion.mockResolvedValue('   ');

      const queries = await buildCrossLingualSearchQueries({
        query: KOREAN_QUESTION,
        repositoryLanguage: 'en',
        workspaceId: 'T1',
      });

      expect(queries).toEqual(buildQmdStructuredSearchQueries(KOREAN_QUESTION, 2));
    });

    it('calls the model once for a repeated question (LRU cache hit)', async () => {
      mockedCompletion.mockResolvedValue(ENGLISH_TRANSLATION);

      const first = await buildCrossLingualSearchQueries({
        query: KOREAN_QUESTION,
        repositoryLanguage: 'en',
        workspaceId: 'T1',
      });
      const second = await buildCrossLingualSearchQueries({
        query: KOREAN_QUESTION,
        repositoryLanguage: 'en',
        workspaceId: 'T1',
      });

      expect(second).toEqual(first);
      expect(mockedCompletion).toHaveBeenCalledTimes(1);

      // A different workspace is a different anonymization map, so it is a miss.
      await buildCrossLingualSearchQueries({ query: KOREAN_QUESTION, repositoryLanguage: 'en', workspaceId: 'T2' });
      expect(mockedCompletion).toHaveBeenCalledTimes(2);
    });

    it('never calls the model when the flag is off', async () => {
      process.env.QMD_QUERY_TRANSLATION = 'false';

      const queries = await buildCrossLingualSearchQueries({
        query: KOREAN_QUESTION,
        repositoryLanguage: 'en',
        workspaceId: 'T1',
      });

      expect(queries).toEqual(buildQmdStructuredSearchQueries(KOREAN_QUESTION, 2));
      expect(mockedCompletion).not.toHaveBeenCalled();
    });
  });

  describe('translateSearchQuery', () => {
    it('strips quotes and label prefixes from the model output', async () => {
      mockedCompletion.mockResolvedValue(`Translation: "${ENGLISH_TRANSLATION}"\nnote: ignored`);

      expect(await translateSearchQuery({ query: KOREAN_QUESTION, targetLanguage: 'en' })).toBe(ENGLISH_TRANSLATION);
    });

    it('rejects an answer that is prose rather than a query', async () => {
      mockedCompletion.mockResolvedValue('x'.repeat(401));

      expect(await translateSearchQuery({ query: KOREAN_QUESTION, targetLanguage: 'en' })).toBeNull();
    });

    it('gives up on a slow model instead of stalling the answer', async () => {
      jest.useFakeTimers();
      mockedCompletion.mockReturnValue(new Promise<string>(() => {}));

      const pending = translateSearchQuery({ query: KOREAN_QUESTION, targetLanguage: 'en' });
      await Promise.resolve();
      jest.advanceTimersByTime(2100);

      await expect(pending).resolves.toBeNull();
      jest.useRealTimers();
    });
  });
});
