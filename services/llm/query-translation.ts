import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { type LanguageCode, detectLanguage, languageName } from 'services/common/language';
import { Logger } from 'services/common/logger';
import {
  type QmdStructuredSearchQuery,
  buildQmdLexQueryCandidates,
  buildQmdStructuredSearchQueries,
} from 'services/retrieval/qmd-lex-search';
import { createChatCompletion } from './completions';

/**
 * Cross-lingual retrieval: a Korean question over an English repository.
 *
 * The lexical leg is already script-aware (`qmd-lex-search`), but no amount of
 * stemming makes `휴가` match `vacation`, and the single multilingual embedding
 * model CHOIR runs on CPU puts a Korean question and an English document in
 * different neighbourhoods. So the question is translated into the repository's
 * language once and added as a *second* vector query, with its own lexical
 * candidates. The original-language query stays first: QMD weights the first
 * query in the list at 2.0 in its RRF fusion, and the asker's own words are
 * still the better signal whenever the repository does hold their language.
 *
 * Every failure mode here is non-fatal — a slow, broken or disabled model just
 * means the search runs exactly as it did before this hook existed.
 */

/** A slow model must not stall an answer; the untranslated search is fine. */
const TRANSLATION_TIMEOUT_MS = 2000;
const TRANSLATION_MAX_TOKENS = 120;
/** Per-process LRU. Questions repeat far more often than the cost of a miss. */
const TRANSLATION_CACHE_LIMIT = 200;
/** A "translation" longer than this is the model chatting, not translating. */
const MAX_TRANSLATION_LENGTH = 400;

const translationCache = new Map<string, string>();

function cacheKey(workspaceId: string | undefined, targetLanguage: LanguageCode, query: string): string {
  return `${workspaceId ?? 'global'}::${targetLanguage}::${query}`;
}

function readCache(key: string): string | undefined {
  const cached = translationCache.get(key);
  if (cached === undefined) {
    return undefined;
  }

  // Refresh recency.
  translationCache.delete(key);
  translationCache.set(key, cached);
  return cached;
}

function writeCache(key: string, value: string): void {
  translationCache.set(key, value);
  while (translationCache.size > TRANSLATION_CACHE_LIMIT) {
    const oldest = translationCache.keys().next();
    if (oldest.done) break;
    translationCache.delete(oldest.value);
  }
}

/** Test seam: the cache is process-global and would leak between cases. */
export function resetQueryTranslationCache(): void {
  translationCache.clear();
}

export function isQueryTranslationEnabled(): boolean {
  const flag = process.env.QMD_QUERY_TRANSLATION?.trim().toLowerCase();
  return flag !== 'false' && flag !== '0' && flag !== 'off';
}

function sanitizeTranslation(raw: string | undefined | null): string | null {
  if (!raw) return null;

  const firstLine = raw
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;

  // Models like to wrap a translation in quotes or prefix it with a label.
  const unquoted = firstLine
    .replace(/^(translation|translated query|번역)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .trim();

  if (!unquoted || unquoted.length > MAX_TRANSLATION_LENGTH) {
    return null;
  }

  return unquoted;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Query translation timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Translates a search question into `targetLanguage`, or returns `null` when
 * the flag is off, the model fails, or the answer does not look like a
 * translation. Anonymization is deliberately left ON: a question can name a
 * person, and it must be masked on the way out and restored on the way back
 * exactly like every other LLM call in CHOIR.
 */
export async function translateSearchQuery(params: {
  query: string;
  targetLanguage: LanguageCode;
  workspaceId?: string;
}): Promise<string | null> {
  const normalized = params.query.trim().replace(/\s+/g, ' ');
  if (!normalized || !isQueryTranslationEnabled()) {
    return null;
  }

  const key = cacheKey(params.workspaceId, params.targetLanguage, normalized);
  const cached = readCache(key);
  if (cached !== undefined) {
    return cached || null;
  }

  const target = languageName(params.targetLanguage);
  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: [
        `You translate documentation search queries into ${target}.`,
        `Reply with the ${target} translation of the query and nothing else: no quotes, no labels, no explanation.`,
        'Keep product names, code identifiers, file paths and acronyms exactly as written.',
        'Preferring the wording a technical document would use is better than a literal translation.',
      ].join(' '),
    },
    { role: 'user', content: normalized },
  ];

  try {
    const response = await withTimeout(
      createChatCompletion(messages, {
        workspaceId: params.workspaceId,
        purpose: 'classification',
        temperature: 0,
        max_tokens: TRANSLATION_MAX_TOKENS,
        function_name: 'translateSearchQuery',
      }),
      TRANSLATION_TIMEOUT_MS,
    );

    const translation = sanitizeTranslation(response);
    if (!translation) {
      Logger.debug('Query translation produced no usable output; searching with the original query only.', {
        workspaceId: params.workspaceId,
        targetLanguage: params.targetLanguage,
      });
      return null;
    }

    writeCache(key, translation);
    return translation;
  } catch (error) {
    // Never fail a search because a translation failed.
    Logger.debug('Query translation failed; searching with the original query only.', {
      workspaceId: params.workspaceId,
      targetLanguage: params.targetLanguage,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function dedupeQueries(queries: QmdStructuredSearchQuery[]): QmdStructuredSearchQuery[] {
  const seen = new Set<string>();
  const deduped: QmdStructuredSearchQuery[] = [];

  for (const entry of queries) {
    const key = `${entry.type}:${entry.query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

/**
 * Builds the structured query list QMD searches with, adding a translated
 * vector query (and its lexical candidates) when the question is not written in
 * the repository's language. Identical to
 * {@link buildQmdStructuredSearchQueries} in every other case.
 */
export async function buildCrossLingualSearchQueries(params: {
  query: string;
  repositoryLanguage?: LanguageCode;
  workspaceId?: string;
  maxLexCandidates?: number;
}): Promise<QmdStructuredSearchQuery[]> {
  const maxLexCandidates = params.maxLexCandidates ?? 2;
  const base = buildQmdStructuredSearchQueries(params.query, maxLexCandidates);

  if (base.length === 0 || !params.repositoryLanguage) {
    return base;
  }

  const questionLanguage = detectLanguage(params.query);
  if (questionLanguage === params.repositoryLanguage) {
    return base;
  }

  const translation = await translateSearchQuery({
    query: params.query,
    targetLanguage: params.repositoryLanguage,
    workspaceId: params.workspaceId,
  });
  if (!translation) {
    return base;
  }

  const originalVec = base.filter((entry) => entry.type === 'vec');
  const originalRest = base.filter((entry) => entry.type !== 'vec');
  const translatedLex: QmdStructuredSearchQuery[] = buildQmdLexQueryCandidates(translation)
    .slice(0, Math.max(1, maxLexCandidates))
    .map((candidate) => ({ type: 'lex', query: candidate }));

  return dedupeQueries([
    // The asker's own words stay at index 0: QMD weights that leg at 2.0.
    ...originalVec,
    { type: 'vec', query: translation },
    ...originalRest,
    ...translatedLex,
  ]);
}
