const ENGLISH_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'the',
  'their',
  'there',
  'they',
  'this',
  'to',
  'us',
  'was',
  'we',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
]);

/**
 * Korean stopwords: question words, demonstratives, copulas, and generic nouns.
 * Applied AFTER particle/ending stripping, so entries are the stripped forms.
 */
const KOREAN_STOPWORDS = new Set([
  '것',
  '수',
  '등',
  '및',
  '또는',
  '그리고',
  '그',
  '이',
  '저',
  '그것',
  '이것',
  '저것',
  '어떻게',
  '언제',
  '어디',
  '무엇',
  '뭐',
  '왜',
  '누가',
  '누구',
  '어느',
  '어떤',
  '좀',
  '혹시',
  '관련',
  '대해',
  '대한',
  '대해서',
  '경우',
  '정도',
  '때',
  '알려주세요',
  '알려줘',
  '궁금',
  '궁금합니다',
  '궁금해요',
  '있나요',
  '있어요',
  '있습니까',
  '있을까요',
  '없나요',
  '하나요',
  '되나요',
  '되어',
  '인가요',
  '입니까',
  '해주세요',
]);

/**
 * Trailing particles (조사) stripped from Hangul tokens. QMD's FTS5 table uses
 * `tokenize='porter unicode61'` and matches `"term"*`, so the *stripped* stem is
 * the higher-recall query form: `휴가` prefix-matches both `휴가` and `휴가는`,
 * while `휴가는` matches neither `휴가` nor `휴가를`.
 */
const KOREAN_PARTICLES = [
  '에게서',
  '으로부터',
  '에서는',
  '에게는',
  '으로는',
  '에서',
  '에게',
  '께서',
  '으로',
  '이랑',
  '처럼',
  '보다',
  '부터',
  '까지',
  '한테',
  '이나',
  '라고',
  '이라고',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '도',
  '만',
  '와',
  '과',
  '랑',
  '로',
  '나',
  '야',
];

/**
 * Common conjugational endings (어미) trimmed from Hangul tokens so that
 * `신청하나요` reduces to the `신청` stem. This is a fixed-list heuristic, not a
 * morphological analyzer: it only has to expose a prefix that FTS5 can match.
 */
const KOREAN_VERB_ENDINGS = [
  '했습니다',
  '합니다',
  '됩니다',
  '입니다',
  '하나요',
  '되나요',
  '있나요',
  '없나요',
  '인가요',
  '할까요',
  '하세요',
  '했나요',
  '했어요',
  '해요',
  '하다',
  '되다',
  '했다',
  '된다',
  '한다',
  '하고',
  '해서',
  '되어',
  '하면',
  '되면',
  '되는',
  '하는',
  '했던',
  '하던',
  '인',
  '임',
];

const byLengthDesc = (left: string, right: string): number => right.length - left.length;
const SORTED_KOREAN_PARTICLES = [...KOREAN_PARTICLES].sort(byLengthDesc);
const SORTED_KOREAN_VERB_ENDINGS = [...KOREAN_VERB_ENDINGS].sort(byLengthDesc);

const HANGUL_SYLLABLE_PATTERN = /[가-힣]/;
const TRAILING_HANGUL_RUN_PATTERN = /[가-힣]+$/;

const MIN_HANGUL_STEM_SYLLABLES = 2;
const MIN_LATIN_STEM_LENGTH = 2;
const MIN_HANGUL_SYLLABLES_FOR_ENDING_TRIM = 3;

/**
 * Strips at most one suffix from the token's trailing Hangul run, longest first.
 * The suffix is only removed when what remains is still a usable stem: either
 * >= 2 Hangul syllables, or (for mixed tokens like `Slack에서`) an entirely
 * consumed Hangul run leaving a non-Hangul base of >= 2 characters.
 */
function stripTrailingHangulSuffix(token: string, suffixes: string[]): string {
  const trailingHangul = token.match(TRAILING_HANGUL_RUN_PATTERN);
  if (!trailingHangul) {
    return token;
  }

  const hangulRun = trailingHangul[0];
  const base = token.slice(0, token.length - hangulRun.length);

  for (const suffix of suffixes) {
    if (hangulRun.length < suffix.length || !hangulRun.endsWith(suffix)) {
      continue;
    }

    const remainder = hangulRun.slice(0, hangulRun.length - suffix.length);
    if (remainder.length === 0) {
      if (base.length >= MIN_LATIN_STEM_LENGTH) {
        return base;
      }
      continue;
    }

    if (remainder.length >= MIN_HANGUL_STEM_SYLLABLES) {
      return base + remainder;
    }
  }

  return token;
}

/**
 * Reduces a Hangul (or Hangul-suffixed) token to a prefix-matchable stem by
 * removing one particle and then one conjugational ending. Non-Hangul tokens —
 * including hyphenated ones like `node-diff3` — are returned untouched.
 */
function normalizeKoreanToken(token: string): string {
  if (!HANGUL_SYLLABLE_PATTERN.test(token)) {
    return token;
  }

  const withoutParticle = stripTrailingHangulSuffix(token, SORTED_KOREAN_PARTICLES);
  const trailingHangul = withoutParticle.match(TRAILING_HANGUL_RUN_PATTERN);
  if (!trailingHangul || trailingHangul[0].length < MIN_HANGUL_SYLLABLES_FOR_ENDING_TRIM) {
    return withoutParticle;
  }

  return stripTrailingHangulSuffix(withoutParticle, SORTED_KOREAN_VERB_ENDINGS);
}

function isStopword(token: string): boolean {
  if (HANGUL_SYLLABLE_PATTERN.test(token)) {
    return KOREAN_STOPWORDS.has(token);
  }

  return ENGLISH_STOPWORDS.has(token.toLowerCase());
}

interface QmdLexSearchStore<TResult> {
  searchLex(query: string, options?: { limit?: number; collection?: string }): Promise<TResult[]>;
}

export interface QmdStructuredSearchQuery {
  type: 'lex' | 'vec' | 'hyde';
  query: string;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

export function tokenizeQuery(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) || [];

  return tokens.map((token) => normalizeKoreanToken(token)).filter((token) => token.length > 1 && !isStopword(token));
}

export function buildQmdLexQueryCandidates(query: string): string[] {
  const normalized = query.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return [];
  }

  const punctuationStripped = normalized
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = tokenizeQuery(punctuationStripped || normalized);
  const candidates: string[] = [];

  // The verbatim rungs carry particles and conjugational endings that FTS5's
  // `"term"*` prefix match cannot reach (`휴가는` matches neither `휴가` nor
  // `휴가를`), so for Hangul queries they reliably miss. Lead with the stemmed
  // join instead and keep them as later fallbacks. Non-Hangul queries keep the
  // original ordering byte for byte.
  if (tokens.length > 0 && HANGUL_SYLLABLE_PATTERN.test(normalized)) {
    candidates.push(tokens.join(' '));
  }

  candidates.push(normalized);

  if (punctuationStripped && punctuationStripped !== normalized) {
    candidates.push(punctuationStripped);
  }

  if (tokens.length > 0) {
    candidates.push(tokens.join(' '));

    const maxGramSize = Math.min(3, tokens.length);
    for (let gramSize = maxGramSize; gramSize >= 2; gramSize -= 1) {
      for (let index = 0; index <= tokens.length - gramSize; index += 1) {
        candidates.push(tokens.slice(index, index + gramSize).join(' '));
      }
    }

    candidates.push(...tokens.sort((left, right) => right.length - left.length));
  }

  return dedupeStrings(candidates).slice(0, 10);
}

export function buildQmdStructuredSearchQueries(query: string, maxLexCandidates = 3): QmdStructuredSearchQuery[] {
  const normalized = query.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return [];
  }

  const queries: QmdStructuredSearchQuery[] = [
    {
      type: 'vec',
      query: normalized,
    },
  ];

  for (const candidate of buildQmdLexQueryCandidates(normalized).slice(0, Math.max(1, maxLexCandidates))) {
    queries.push({
      type: 'lex',
      query: candidate,
    });
  }

  return dedupeStrings(queries.map((entry) => `${entry.type}:${entry.query}`)).map((value) => {
    const separatorIndex = value.indexOf(':');
    return {
      type: value.slice(0, separatorIndex) as QmdStructuredSearchQuery['type'],
      query: value.slice(separatorIndex + 1),
    };
  });
}

export async function searchQmdLexWithFallback<TResult extends { filepath: string; score: number }>(params: {
  store: QmdLexSearchStore<TResult>;
  query: string;
  limit: number;
  collection: string;
}): Promise<{ results: TResult[]; queryCandidates: string[]; matchedCandidate?: string }> {
  const queryCandidates = buildQmdLexQueryCandidates(params.query);
  const mergedResults = new Map<string, TResult>();
  let matchedCandidate: string | undefined;

  for (const candidate of queryCandidates) {
    const results = await params.store.searchLex(candidate, {
      limit: Math.max(params.limit * 3, params.limit),
      collection: params.collection,
    });

    if (results.length > 0 && !matchedCandidate) {
      matchedCandidate = candidate;
    }

    for (const result of results) {
      const existing = mergedResults.get(result.filepath);
      if (!existing || result.score > existing.score) {
        mergedResults.set(result.filepath, result);
      }
    }

    if (mergedResults.size >= params.limit) {
      break;
    }
  }

  return {
    results: Array.from(mergedResults.values())
      .sort((left, right) => right.score - left.score)
      .slice(0, params.limit),
    queryCandidates,
    matchedCandidate,
  };
}
