/**
 * The glossary as the model sees it.
 *
 * One line per term, because that is the densest form a model still reads
 * reliably, and a hard token cap, because this block rides along with every
 * chunk of every conversion: a 400-term organization glossary would otherwise
 * be paid for once per chunk and crowd out the document itself.
 *
 * When the cap bites, the entries the text actually mentions win. That choice
 * is free (string matching, no model call) and it is the one that matters —
 * a term the page never uses cannot be mis-transcribed on it.
 *
 * See docs/meeting-notes-and-glossary.md, 용어집 §4.
 */

import type { GlossaryEntry, GlossaryLanguage } from './parse';

export interface GlossaryPromptBlockOptions {
  /** The text being transcribed; decides which entries survive the cap. */
  text?: string;
  maxTokens?: number;
  language?: GlossaryLanguage;
}

const DEFAULT_MAX_TOKENS = 1500;

const INSTRUCTION: Record<GlossaryLanguage, string> = {
  en: "These are the organization's own terms: write every mention in the canonical form on the left, correcting misheard, misspelled or abbreviated forms to it.",
  ko: '아래는 이 조직에서 쓰는 용어다. 본문에 나오는 잘못 받아쓴 표기·오기·약칭은 왼쪽의 정식 표기로 고쳐 쓴다.',
};

/**
 * Tokens, roughly. A tokenizer call per chunk is not worth its latency here,
 * and both constants come from the same place: a BPE vocabulary spends about
 * one token per 4 characters of Latin text, and about one per 3 characters of
 * Hangul (Korean syllables are multi-byte and split more often). Over-counting
 * slightly is the safe direction — it drops an entry, it never blows the cap.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const compact = text.replace(/\s/g, '');
  if (compact.length === 0) return 0;
  const hangul = (compact.match(/[가-힣ᄀ-ᇿ]/g) ?? []).length;
  const divisor = hangul / compact.length >= 0.3 ? 3 : 4;
  return Math.ceil(text.length / divisor);
}

export function glossaryPromptBlock(entries: GlossaryEntry[], options: GlossaryPromptBlockOptions = {}): string {
  if (entries.length === 0) return '';

  const language = options.language ?? 'en';
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const instruction = INSTRUCTION[language];

  const lines = entries.map((entry) => entryLine(entry));
  const whole = [instruction, ...lines].join('\n');
  if (estimateTokens(whole) <= maxTokens) return whole;

  // Over the cap: mentioned entries first (in their original order), then the
  // rest, cutting where the budget runs out.
  const mentioned = options.text
    ? entries.map((entry) => mentions(entry, options.text ?? ''))
    : entries.map(() => false);
  const ordered = [...lines.keys()]
    .filter((index) => mentioned[index])
    .concat([...lines.keys()].filter((index) => !mentioned[index]));

  const kept: string[] = [];
  let used = estimateTokens(instruction);
  for (const index of ordered) {
    const cost = estimateTokens(`\n${lines[index]}`);
    if (used + cost > maxTokens) continue;
    used += cost;
    kept.push(lines[index]);
  }

  // Everything was too long even alone: an instruction with no terms is noise.
  if (kept.length === 0) return '';
  return [instruction, ...kept].join('\n');
}

function entryLine(entry: GlossaryEntry): string {
  const aliases = entry.aliases.filter((alias) => alias.trim().length > 0);
  const head = aliases.length > 0 ? `${entry.term} (${aliases.join(', ')})` : entry.term;
  return entry.description.trim() ? `${head}: ${entry.description.trim()}` : head;
}

/** Whether the text uses this entry's term or one of its aliases. */
export function mentions(entry: GlossaryEntry, text: string): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  return [entry.term, ...entry.aliases].some((name) => occursIn(haystack, name));
}

/**
 * Latin names match on word boundaries — "RAG" must not fire on "storage" —
 * while Hangul and other scripts match as substrings, because Korean glues
 * particles onto a noun ("CHOIR에서", "코이어를") and a boundary test would
 * miss every real mention.
 */
function occursIn(lowercasedText: string, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  if (/^[\x20-\x7e]+$/.test(needle)) {
    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`);
    return pattern.test(lowercasedText);
  }
  return lowercasedText.includes(needle);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
