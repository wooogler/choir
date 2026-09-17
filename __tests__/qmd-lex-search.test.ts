import {
  buildQmdLexQueryCandidates,
  buildQmdStructuredSearchQueries,
  searchQmdLexWithFallback,
  tokenizeQuery,
} from '@/services/retrieval/qmd-lex-search';

const HANGUL_SYLLABLE = /[가-힣]/;

describe('tokenizeQuery - Korean', () => {
  it('strips particles and verb endings from a natural Korean question', () => {
    const tokens = tokenizeQuery('휴가는 어떻게 신청하나요?');

    expect(tokens).toEqual(['휴가', '신청']);
    expect(tokens).not.toContain('어떻게');
    expect(tokens).not.toContain('휴가는');
    for (const token of tokens) {
      expect(token.length).toBeGreaterThan(1);
    }
  });

  it('strips the longest matching particle first', () => {
    expect(tokenizeQuery('팀장에게서 승인을')).toEqual(['팀장', '승인']);
  });

  it('strips 으로부터 rather than the shorter 로/부터 suffixes', () => {
    expect(tokenizeQuery('관리자으로부터')).toEqual(['관리자']);
  });

  it('trims conjugational endings down to the stem', () => {
    expect(tokenizeQuery('신청했습니다')).toEqual(['신청']);
    expect(tokenizeQuery('배포됩니다')).toEqual(['배포']);
    expect(tokenizeQuery('정책입니다')).toEqual(['정책']);
  });

  it('never reduces a token below two Hangul syllables', () => {
    expect(tokenizeQuery('회의')).toEqual(['회의']);
    // `의` and `가` are particles, but stripping them would leave one syllable.
    expect(tokenizeQuery('이가')).toEqual(['이가']);
    expect(tokenizeQuery('보고')).toEqual(['보고']);
    // `하나요` is a full ending but leaves nothing behind, so the token survives
    // stripping and is removed as a stopword instead.
    expect(tokenizeQuery('하나요')).toEqual([]);
  });

  it('drops Korean stopwords after stripping', () => {
    expect(tokenizeQuery('그것은 무엇인가요 알려주세요')).toEqual([]);
    expect(tokenizeQuery('보안 정책에 대해서 궁금합니다')).toEqual(['보안', '정책']);
  });

  it('drops single-syllable Korean tokens', () => {
    expect(tokenizeQuery('그 수 등 및 배포')).toEqual(['배포']);
  });
});

describe('tokenizeQuery - English regression', () => {
  it('leaves English tokenization untouched', () => {
    expect(tokenizeQuery('How do I request vacation days?')).toEqual(['request', 'vacation', 'days']);
  });

  it('keeps hyphenated tokens intact', () => {
    expect(tokenizeQuery('What is node-diff3 used for?')).toEqual(['node-diff3', 'used']);
  });
});

describe('buildQmdLexQueryCandidates - English regression', () => {
  // Captured from the implementation BEFORE Korean support was added; these
  // must stay byte-identical.
  it('produces the exact pre-existing ladder for an English question', () => {
    expect(buildQmdLexQueryCandidates('How do I request vacation days?')).toEqual([
      'How do I request vacation days?',
      'How do I request vacation days',
      'request vacation days',
      'request vacation',
      'vacation days',
      'vacation',
      'request',
      'days',
    ]);
  });

  it('produces the exact pre-existing ladder for a hyphenated English question', () => {
    expect(buildQmdLexQueryCandidates('What is node-diff3 used for?')).toEqual([
      'What is node-diff3 used for?',
      'What is node-diff3 used for',
      'node-diff3 used',
      'node-diff3',
      'used',
    ]);
  });

  it('caps the ladder at ten candidates', () => {
    const candidates = buildQmdLexQueryCandidates(
      'How do I configure deployment rollback policy for staging clusters safely?',
    );

    expect(candidates.length).toBeLessThanOrEqual(10);
    expect(candidates[0]).toBe('How do I configure deployment rollback policy for staging clusters safely?');
  });
});

describe('buildQmdLexQueryCandidates - Korean', () => {
  it('leads with the stemmed join and demotes the verbatim rungs', () => {
    const candidates = buildQmdLexQueryCandidates('휴가는 어떻게 신청하나요?');

    // The stemmed join goes first: the verbatim rungs still carry particles and
    // endings that FTS5 prefix matching cannot reach.
    expect(candidates[0]).toBe('휴가 신청');
    expect(candidates).toEqual(['휴가 신청', '휴가는 어떻게 신청하나요?', '휴가는 어떻게 신청하나요', '휴가', '신청']);
  });

  it('builds candidates from particle-stripped stems', () => {
    const candidates = buildQmdLexQueryCandidates('팀장에게서 승인을');

    expect(candidates[0]).toBe('팀장 승인');
    expect(candidates).toEqual(['팀장 승인', '팀장에게서 승인을', '팀장', '승인']);
  });

  it('falls back to the verbatim query when every token is a stopword', () => {
    expect(buildQmdLexQueryCandidates('어떻게 하나요')).toEqual(['어떻게 하나요']);
  });

  it('leaves a two-syllable query alone', () => {
    expect(buildQmdLexQueryCandidates('회의')).toEqual(['회의']);
  });

  it('dedupes candidates', () => {
    const candidates = buildQmdLexQueryCandidates('휴가는 휴가를 신청하나요');
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe('buildQmdLexQueryCandidates - mixed script', () => {
  it('strips Korean particles from Latin-stemmed tokens and keeps their casing', () => {
    const tokens = tokenizeQuery('Slack에서 GitHub 연동은 어떻게 하나요');

    expect(tokens).toEqual(['Slack', 'GitHub', '연동']);

    expect(buildQmdLexQueryCandidates('Slack에서 GitHub 연동은 어떻게 하나요')).toEqual([
      'Slack GitHub 연동',
      'Slack에서 GitHub 연동은 어떻게 하나요',
      'Slack GitHub',
      'GitHub 연동',
      'GitHub',
      'Slack',
      '연동',
    ]);
  });

  it('does not emit Hangul-only fragments shorter than two syllables', () => {
    for (const token of tokenizeQuery('Slack에서 GitHub 연동은 어떻게 하나요')) {
      if (HANGUL_SYLLABLE.test(token)) {
        expect(token.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe('buildQmdStructuredSearchQueries', () => {
  it('passes the verbatim question as the vec query', () => {
    const queries = buildQmdStructuredSearchQueries('휴가는 어떻게 신청하나요?', 2);

    expect(queries[0]).toEqual({ type: 'vec', query: '휴가는 어떻게 신청하나요?' });
    expect(queries.filter((entry) => entry.type === 'vec')).toHaveLength(1);
    expect(queries.filter((entry) => entry.type === 'lex')).toHaveLength(2);
  });

  it('collapses internal whitespace but does not stem the vec query', () => {
    const queries = buildQmdStructuredSearchQueries('  팀장에게서   승인을  ', 1);

    expect(queries[0]).toEqual({ type: 'vec', query: '팀장에게서 승인을' });
  });

  it('returns nothing for an empty query', () => {
    expect(buildQmdStructuredSearchQueries('   ')).toEqual([]);
    expect(buildQmdLexQueryCandidates('   ')).toEqual([]);
  });
});

describe('searchQmdLexWithFallback', () => {
  it('tries the stemmed join first for a Korean query', async () => {
    const attempted: string[] = [];
    const store = {
      searchLex: async (query: string) => {
        attempted.push(query);
        if (query === '휴가 신청') {
          return [{ filepath: 'docs/leave.md', score: 0.9 }];
        }
        return [];
      },
    };

    const result = await searchQmdLexWithFallback({
      store,
      query: '휴가는 어떻게 신청하나요?',
      limit: 1,
      collection: 'docs',
    });

    // The stemmed join now hits on the first attempt, so the two verbatim rungs
    // that used to burn a round-trip each are never issued.
    expect(attempted).toEqual(['휴가 신청']);
    expect(result.matchedCandidate).toBe('휴가 신청');
    expect(result.results).toEqual([{ filepath: 'docs/leave.md', score: 0.9 }]);
    expect(result.queryCandidates).toEqual(buildQmdLexQueryCandidates('휴가는 어떻게 신청하나요?'));
  });
});
