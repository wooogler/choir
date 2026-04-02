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

function tokenizeQuery(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) || [];

  return tokens.filter((token) => {
    const normalized = token.toLowerCase();
    return normalized.length > 1 && !ENGLISH_STOPWORDS.has(normalized);
  });
}

export function buildQmdLexQueryCandidates(query: string): string[] {
  const normalized = query.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return [];
  }

  const punctuationStripped = normalized.replace(/[^\p{L}\p{N}\s-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const tokens = tokenizeQuery(punctuationStripped || normalized);
  const candidates: string[] = [normalized];

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
