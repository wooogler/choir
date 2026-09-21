/**
 * Starting a glossary from documents somebody already has.
 *
 * Nobody fills in an empty table. So the first glossary is proposed rather than
 * asked for: a paper, a deck, a handbook goes through the import sources, the
 * markdown comes back here, and the model lists the terms a newcomer to this
 * organization would have to look up. The manager deletes the rows that are
 * noise and commits the rest — which is a minute of work against an hour of it.
 *
 * Two rules shape the prompt. An alias is only written down when the document
 * itself gives one (an acronym beside its expansion, an English term beside its
 * Korean); a guessed alias is worse than none, because the alias column is what
 * transcript correction trusts. And a term already in the glossary never comes
 * back — the same flow has to work on a folder that already has a glossary,
 * where the only useful answer is the new rows.
 *
 * See docs/meeting-notes-and-glossary.md, 용어집 §3a and §4.
 */

import { Logger } from 'services/common/logger';
// The PDF import's config file, for the service tier only: it is a leaf module
// that imports nothing, and one env var read in two places would drift.
import { loadPdfImportConfig } from 'services/import/sources/pdf/config';
import { resolveLLMConfig } from 'services/llm/llm-config';
import { getOpenAIClient } from 'services/llm/openai-client-factory';
import type { GlossaryEntry, GlossaryLanguage } from './parse';
import { estimateTokens } from './prompt-block';

/** What the model proposes: a glossary row that nobody has approved yet. */
export interface GlossaryCandidate {
  term: string;
  /** Other spellings the document itself gave. Usually empty, and that is correct. */
  aliases: string[];
  description: string;
  kind: GlossaryCandidateKind;
  /** Title of the seed document the term was read from, for the preview table. */
  source?: string;
}

export type GlossaryCandidateKind = 'acronym' | 'proper-noun' | 'concept';

const KINDS: readonly GlossaryCandidateKind[] = ['acronym', 'proper-noun', 'concept'];

/**
 * Roughly a quarter of a small model's context, which keeps one call at a few
 * seconds and leaves the whole output budget for terms. Seed documents are
 * often papers of 10–30k tokens, so this is usually two or three calls.
 */
export const CHUNK_MAX_TOKENS = 12_000;

/** A run this long is already more than a manager will review in one sitting. */
export const MAX_CANDIDATES = 150;

/** Per chunk. 60 terms of one line each fits several times over. */
const MAX_OUTPUT_TOKENS = 6000;

/** Extraction is reading, not reasoning; the PDF path found the same. */
const REASONING_EFFORT = 'low' as const;

/** Budget for the "already in the glossary" line, so a 400-term glossary does not become the prompt. */
const EXISTING_TERMS_MAX_TOKENS = 400;

export interface GlossaryLlmResponse {
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

export interface GlossaryResponseRequest {
  model: string;
  input: unknown[];
  max_output_tokens?: number;
  reasoning?: { effort: 'low' | 'medium' | 'high' };
  service_tier?: 'flex' | 'default';
  text?: { format: { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean } };
}

/**
 * The slice of the OpenAI client this module needs, so a test can hand in a
 * fake without constructing a real one (same shape as the PDF converter's).
 */
export interface GlossaryLlmClient {
  responses: { create(body: GlossaryResponseRequest): Promise<GlossaryLlmResponse> };
}

export interface ExtractGlossaryCandidatesParams {
  workspaceId: string;
  /** The seed documents, already converted to markdown and concatenated. */
  markdown: string;
  /** Terms the folder chain already has; these never come back as candidates. */
  existing?: GlossaryEntry[];
  /** Language for the descriptions. Defaults to the document's own language. */
  language?: GlossaryLanguage;
  client?: GlossaryLlmClient;
  model?: string;
}

export const EXTRACTION_RULES = [
  'You are building a glossary for a documentation repository. From the document below, list the terms a newcomer to this organization would have to look up.',
  'Include: acronyms and initialisms together with what they stand for; named systems, datasets, models, products, tools, teams and projects; and concepts the document itself defines.',
  'Skip ordinary words, general vocabulary any reader of this field already knows, section headings, citations, and the names of people.',
  'Write `description` as a single line of at most 140 characters, in the language the document is written in. Say what the thing is; do not say that the document mentions it.',
  'Fill `aliases` ONLY with other spellings the document itself gives — an acronym beside its expansion, or a term beside its translation. Never guess an alias and never invent a misspelling. An empty list is the normal answer.',
  '`kind` is "acronym" for a short form that has an expansion, "proper-noun" for a named thing, and "concept" for something the document defines.',
  'List at most 60 terms from this text, the most useful first. If the text defines nothing worth looking up, return an empty list.',
  'Output JSON only, matching the schema you were given. No prose, no code fence.',
].join('\n');

const LANGUAGE_DIRECTIVE: Record<GlossaryLanguage, string> = {
  ko: 'Write every `description` in Korean. Terms themselves keep their original spelling.',
  en: 'Write every `description` in English. Terms themselves keep their original spelling.',
};

/** Structured Outputs: the parse below still guards, but this is what keeps it boring. */
const CANDIDATE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['terms'],
  properties: {
    terms: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'aliases', 'description', 'kind'],
        properties: {
          term: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          kind: { type: 'string', enum: [...KINDS] },
        },
      },
    },
  },
};

/**
 * Reads term candidates out of one or more seed documents.
 *
 * Long input is split and merged rather than truncated: a glossary built from
 * the first ten pages of a paper would miss exactly the terms the later pages
 * introduce. Chunks are cut at top-level headings first, so a chunk belongs to
 * one seed document and every candidate can be credited to it in the preview.
 */
export async function extractGlossaryCandidates(params: ExtractGlossaryCandidatesParams): Promise<GlossaryCandidate[]> {
  const chunks = chunkMarkdown(params.markdown);
  if (chunks.length === 0) return [];

  const { client, model } = await resolveGlossaryLlm(params.workspaceId, params.client, params.model);
  const serviceTier = loadPdfImportConfig().serviceTier;
  const existing = params.existing ?? [];

  const found: GlossaryCandidate[] = [];
  for (const chunk of chunks) {
    const prompt = buildExtractionPrompt({ text: chunk.text, existing, language: params.language });
    const request: GlossaryResponseRequest = {
      model,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      max_output_tokens: MAX_OUTPUT_TOKENS,
      reasoning: { effort: REASONING_EFFORT },
      service_tier: serviceTier,
      text: {
        format: { type: 'json_schema', name: 'glossary_candidates', schema: CANDIDATE_SCHEMA, strict: true },
      },
    };

    const response = await createWithFallback(client, request);
    const parsed = parseCandidates(response.output_text ?? '');
    for (const candidate of parsed) {
      found.push(chunk.source ? { ...candidate, source: chunk.source } : candidate);
    }
  }

  const merged = mergeCandidates(found, existing);
  Logger.info('Glossary extraction finished', {
    workspaceId: params.workspaceId,
    operation: 'glossary.extract',
    chunks: chunks.length,
    proposed: found.length,
    kept: merged.length,
  });
  return merged;
}

/**
 * Flex trades price for capacity, so "no capacity" is an expected answer rather
 * than a failure — the same fallback the PDF conversion makes, for the same
 * reason: pay full price rather than lose the run.
 */
async function createWithFallback(
  client: GlossaryLlmClient,
  request: GlossaryResponseRequest,
): Promise<GlossaryLlmResponse> {
  try {
    return await client.responses.create(request);
  } catch (error) {
    if (request.service_tier !== 'flex' || !isCapacityError(error)) throw error;
    Logger.warn('Glossary extraction: flex tier unavailable, retrying at the standard tier', {
      operation: 'glossary.extract',
    });
    return client.responses.create({ ...request, service_tier: 'default' });
  }
}

/** 429, or an explicit `resource_unavailable`, both of which mean "try elsewhere". */
function isCapacityError(error: unknown): boolean {
  const candidate = error as { status?: number; code?: string; message?: string; error?: { code?: string } };
  if (candidate?.status === 429) return true;
  const code = candidate?.code ?? candidate?.error?.code ?? '';
  return /resource_unavailable/i.test(code) || /resource_unavailable/i.test(candidate?.message ?? '');
}

/**
 * Picks the client and model. An injected client with a model skips the
 * workspace lookup entirely, which is what keeps tests off the network.
 */
export async function resolveGlossaryLlm(
  workspaceId: string,
  client?: GlossaryLlmClient,
  model?: string,
): Promise<{ client: GlossaryLlmClient; model: string }> {
  if (client && model) return { client, model };
  const resolved = await resolveLLMConfig(workspaceId, 'qa');
  return {
    client: client ?? toGlossaryLlmClient(getOpenAIClient(resolved.apiKey)),
    model: model ?? resolved.model,
  };
}

/**
 * Wraps the real client in the narrow shape above. The cast is deliberate and
 * local: `responses.create` expects its own `ResponseCreateParams` rather than
 * our open request shape.
 */
export function toGlossaryLlmClient(openai: ReturnType<typeof getOpenAIClient>): GlossaryLlmClient {
  return {
    responses: {
      create: (body) => openai.responses.create(body as never) as unknown as Promise<GlossaryLlmResponse>,
    },
  };
}

export interface BuildExtractionPromptParams {
  text: string;
  existing?: GlossaryEntry[];
  language?: GlossaryLanguage;
}

export function buildExtractionPrompt(params: BuildExtractionPromptParams): string {
  const parts = [EXTRACTION_RULES];
  if (params.language) parts.push(LANGUAGE_DIRECTIVE[params.language]);

  const known = existingTermsLine(params.existing ?? []);
  if (known) parts.push(known);

  parts.push('--- document ---', params.text);
  return parts.join('\n\n');
}

/**
 * The terms the folder chain already has, so the model spends its answer on new
 * ones. The merge below drops duplicates anyway; this is what stops a second
 * run from returning nothing but rows that will be thrown away.
 */
function existingTermsLine(existing: GlossaryEntry[]): string {
  if (existing.length === 0) return '';

  const kept: string[] = [];
  let used = 0;
  for (const entry of existing) {
    const term = entry.term.trim();
    if (!term) continue;
    const cost = estimateTokens(`${term}, `);
    if (used + cost > EXISTING_TERMS_MAX_TOKENS) break;
    used += cost;
    kept.push(term);
  }

  if (kept.length === 0) return '';
  const more = existing.length > kept.length ? ', and others' : '';
  return `These terms are already in this glossary — do not list them again: ${kept.join(', ')}${more}.`;
}

export interface MarkdownChunk {
  text: string;
  /** The `# ` heading this chunk sits under — the seed document's title. */
  source?: string;
}

/**
 * Cuts the markdown into pieces the model can read in one call.
 *
 * Top-level headings take precedence over the budget because the route joins
 * the seed documents under one `# <title>` each: a chunk that spanned two of
 * them could not credit its terms to either. Inside a document the cut happens
 * at a blank line once the budget is spent, and only mid-block when a single
 * block (a long table, say) runs far past it on its own.
 */
export function chunkMarkdown(markdown: string, maxTokens: number = CHUNK_MAX_TOKENS): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  let current: string[] = [];
  let tokens = 0;
  let source: string | undefined;
  let inFence = false;

  const flush = () => {
    const text = current.join('\n').trim();
    if (text) chunks.push(source ? { text, source } : { text });
    current = [];
    tokens = 0;
  };

  for (const line of markdown.split('\n')) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) inFence = !inFence;

    const heading = inFence ? null : line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      source = heading[1].trim();
    } else if (tokens >= maxTokens && !inFence && (line.trim() === '' || tokens >= maxTokens * 1.5)) {
      flush();
    }

    current.push(line);
    // The newline the join will put back, so the count matches what is sent.
    tokens += estimateTokens(line) + 1;
  }

  flush();
  return chunks;
}

/**
 * Reads the model's answer, tolerantly.
 *
 * Structured Outputs makes this a formality on the models we use, but the
 * workspace picks its own model: one that wraps the object in a fence, adds a
 * sentence before it, or answers with a bare array must not cost the manager
 * the whole run. Anything that is still not JSON yields no terms, which the
 * route reports as "no terms found".
 */
export function parseCandidates(output: string): GlossaryCandidate[] {
  const raw = jsonValueOf(output);
  if (raw === undefined) return [];

  const list = Array.isArray(raw)
    ? raw
    : ((raw as { terms?: unknown; candidates?: unknown }).terms ??
      (raw as { candidates?: unknown }).candidates ??
      undefined);
  if (!Array.isArray(list)) return [];

  const candidates: GlossaryCandidate[] = [];
  for (const item of list) {
    const candidate = toCandidate(item);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function toCandidate(item: unknown): GlossaryCandidate | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;

  const term = typeof record.term === 'string' ? record.term.trim() : '';
  if (!term) return null;

  const aliases = Array.isArray(record.aliases)
    ? record.aliases
        .filter((alias): alias is string => typeof alias === 'string')
        .map((alias) => alias.trim())
        // An "alias" that repeats the term is the model padding the column.
        .filter((alias) => alias.length > 0 && alias.toLowerCase() !== term.toLowerCase())
    : [];

  const kind = KINDS.includes(record.kind as GlossaryCandidateKind)
    ? (record.kind as GlossaryCandidateKind)
    : 'concept';

  return {
    term,
    aliases,
    description: typeof record.description === 'string' ? record.description.trim() : '',
    kind,
  };
}

/** The first JSON object or array in the text, fenced or not. */
function jsonValueOf(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return undefined;

  const fenced = trimmed.match(/^(?:```|~~~)[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?(?:```|~~~)\s*$/);
  const body = (fenced ? fenced[1] : trimmed).trim();

  const direct = tryParse(body);
  if (direct !== undefined) return direct;

  // A model that wrote a sentence around the JSON: take the outermost braces.
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start === -1 || end <= start) return undefined;
  return tryParse(body.slice(start, end + 1));
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Merges the chunks' answers into the rows the manager will see.
 *
 * A term already in the folder's glossaries is dropped, by its own name and by
 * any alias — the point of running this on a folder that already has a glossary
 * is to see only what is new. Within the run the same term found twice keeps
 * the first description and gains the second's aliases, which is what a term
 * defined in one seed document and used in another looks like.
 */
export function mergeCandidates(candidates: GlossaryCandidate[], existing: GlossaryEntry[]): GlossaryCandidate[] {
  const known = new Set<string>();
  for (const entry of existing) {
    known.add(key(entry.term));
    for (const alias of entry.aliases) known.add(key(alias));
  }

  const merged = new Map<string, GlossaryCandidate>();
  for (const candidate of candidates) {
    const term = candidate.term.trim();
    if (!term) continue;
    // By the term or by any alias: a candidate that shares a name with an entry
    // the glossary already has is that entry under another spelling.
    if (known.has(key(term)) || candidate.aliases.some((alias) => known.has(key(alias)))) continue;

    const seen = merged.get(key(term));
    if (seen) {
      for (const alias of candidate.aliases) {
        if (!seen.aliases.some((kept) => key(kept) === key(alias))) seen.aliases.push(alias);
      }
      continue;
    }

    if (merged.size >= MAX_CANDIDATES) break;
    merged.set(key(term), { ...candidate, term, aliases: [...candidate.aliases] });
  }

  return [...merged.values()];
}

function key(value: string): string {
  return value.trim().toLowerCase();
}
