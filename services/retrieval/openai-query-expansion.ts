import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { Logger } from 'services/common/logger';
import { createStructuredResponse } from 'services/llm/completions';
import { type QmdStructuredSearchQuery, buildQmdStructuredSearchQueries } from './qmd-lex-search';

interface QueryExpansionResponse {
  queries: Array<{
    type: 'lex' | 'vec';
    query: string;
  }>;
}

const queryExpansionCache = new Map<string, { expiresAt: number; queries: QmdStructuredSearchQuery[] }>();

function getCacheTtlMs(): number {
  const parsed = Number.parseInt(process.env.OPENAI_QUERY_EXPANSION_CACHE_TTL_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000;
}

function getMaxLexQueries(): number {
  const parsed = Number.parseInt(process.env.OPENAI_QUERY_EXPANSION_MAX_LEX_QUERIES || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

function buildFallbackQueries(query: string): QmdStructuredSearchQuery[] {
  return buildQmdStructuredSearchQueries(query, getMaxLexQueries());
}

function normalizeQueries(
  query: string,
  queries: Array<{ type: 'lex' | 'vec'; query: string }>,
): QmdStructuredSearchQuery[] {
  const cleaned = queries
    .map((entry) => ({
      type: entry.type,
      query: entry.query.trim().replace(/\s+/g, ' '),
    }))
    .filter((entry) => entry.query.length > 0);

  const deduped = new Map<string, QmdStructuredSearchQuery>();
  for (const entry of cleaned) {
    deduped.set(`${entry.type}:${entry.query.toLowerCase()}`, entry);
  }

  const normalized = Array.from(deduped.values());
  const hasVectorQuery = normalized.some((entry) => entry.type === 'vec');
  if (!hasVectorQuery) {
    normalized.unshift({
      type: 'vec',
      query: query.trim().replace(/\s+/g, ' '),
    });
  }

  const maxLexQueries = getMaxLexQueries();
  const finalQueries: QmdStructuredSearchQuery[] = [];
  let lexCount = 0;

  for (const entry of normalized) {
    if (entry.type === 'lex') {
      if (lexCount >= maxLexQueries) {
        continue;
      }
      lexCount += 1;
    }

    finalQueries.push(entry);
  }

  return finalQueries.length > 0 ? finalQueries : buildFallbackQueries(query);
}

export async function expandQueryWithOpenAI(params: {
  query: string;
  intent?: string;
  purpose: 'qa' | 'update';
  workspaceId?: string;
}): Promise<QmdStructuredSearchQuery[]> {
  const normalizedQuery = params.query.trim().replace(/\s+/g, ' ');
  if (!normalizedQuery) {
    return [];
  }

  const cacheKey = `${params.purpose}:${params.intent || ''}:${normalizedQuery.toLowerCase()}`;
  const cached = queryExpansionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.queries;
  }

  const maxLexQueries = getMaxLexQueries();
  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You generate compact retrieval queries for a markdown documentation search engine.

Return:
- exactly one "vec" query that preserves the user's semantic intent in a natural short sentence
- up to ${maxLexQueries} "lex" queries that are concise keyword phrases for BM25/FTS

Rules:
- queries must be plain strings with no explanations
- do not include quotes, markdown, boolean operators, or field syntax
- prefer terminology likely to appear verbatim in docs for lex queries
- keep lex queries short, usually 2 to 6 words
- keep the vec query faithful to the user's wording and intent
- if purpose is 'update', focus queries on locating the existing documentation that should be changed`,
    },
    {
      role: 'user',
      content: `Purpose: ${params.purpose}
Intent: ${params.intent || 'none'}
User query: ${normalizedQuery}`,
    },
  ];

  try {
    const result = await createStructuredResponse<QueryExpansionResponse>(messages, {
      workspaceId: params.workspaceId,
      purpose: params.purpose === 'qa' ? 'qa' : 'document-update',
      temperature: 0,
      max_tokens: 250,
      function_name: 'expandQueryWithOpenAI',
      schemaName: 'retrieval_query_expansion',
      schemaDescription: 'Compact retrieval queries for markdown search',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queries: {
            type: 'array',
            minItems: 1,
            maxItems: maxLexQueries + 1,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: {
                  type: 'string',
                  enum: ['lex', 'vec'],
                },
                query: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 200,
                },
              },
              required: ['type', 'query'],
            },
          },
        },
        required: ['queries'],
      },
    });

    const queries = normalizeQueries(normalizedQuery, result.queries);
    queryExpansionCache.set(cacheKey, {
      expiresAt: Date.now() + getCacheTtlMs(),
      queries,
    });
    Logger.info('OpenAI query expansion generated structured retrieval queries.', {
      purpose: params.purpose,
      originalQuery: normalizedQuery,
      queries,
    });
    return queries;
  } catch (error) {
    Logger.warn('OpenAI query expansion failed. Falling back to local query simplification.', error as Error);
    const fallback = buildFallbackQueries(normalizedQuery);
    queryExpansionCache.set(cacheKey, {
      expiresAt: Date.now() + getCacheTtlMs(),
      queries: fallback,
    });
    return fallback;
  }
}
