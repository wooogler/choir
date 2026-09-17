/**
 * Tiny script-based language detection.
 *
 * CHOIR writes LLM output into documents and answers in Slack, and both must
 * stay in the asker's / the document's language. The model handles that when a
 * prompt tells it to, but hardcoded fallback strings and prompt-level language
 * hints need a cheap, dependency-free guess. This is deliberately a Unicode
 * range vote over the text — not a real classifier — so it never fails, never
 * costs a model call, and degrades to English.
 */

export type LanguageCode = 'ko' | 'ja' | 'zh' | 'en';

// Hangul syllables + jamo.
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/g;
// Hiragana + katakana (kana is the reliable Japanese marker; Han is shared).
const KANA = /[぀-ゟ゠-ヿ]/g;
// CJK ideographs (unified + extension A).
const HAN = /[一-鿿㐀-䶿]/g;

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/**
 * Guesses the language of `text` from the scripts it uses. Korean wins over
 * kana/Han when Hangul is present (Korean text may quote kanji), kana marks
 * Japanese, bare Han marks Chinese, and anything else is English.
 */
export function detectLanguage(text?: string | null): LanguageCode {
  if (!text) return 'en';

  const hangul = count(text, HANGUL);
  const kana = count(text, KANA);
  const han = count(text, HAN);

  if (hangul > 0 && hangul >= kana) return 'ko';
  if (kana > 0) return 'ja';
  if (han > 0) return 'zh';
  return 'en';
}

// Syllables only: a document's jamo/compatibility-jamo are usually decorative.
const HANGUL_SYLLABLES = /[가-힣]/g;
const LATIN = /[A-Za-z]/g;

/**
 * A CJK character carries roughly a word's worth of meaning where a Latin
 * letter carries a fraction of one, so raw character counts under-weigh CJK.
 * This factor is what keeps a Korean document full of English tech terms and
 * URLs reading as Korean.
 */
const CJK_DENSITY_WEIGHT = 2;

/** Removes the parts of a markdown document that are code or machine addresses, not prose. */
function stripNonProse(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?```/g, ' ') // fenced code
      .replace(/~~~[\s\S]*?~~~/g, ' ')
      .replace(/`[^`\n]*`/g, ' ') // inline code
      // Link/image destinations: drop the target, keep the visible text and alt text.
      .replace(/\]\([^)]*\)/g, '] ')
      .replace(/\bhttps?:\/\/\S+/g, ' ') // bare URLs (incl. reference definitions)
      .replace(/<[^>\s]*>/g, ' ') // autolinks and raw HTML tags
  );
}

/**
 * Guesses the language a whole markdown document is written in.
 *
 * Unlike {@link detectLanguage} — which is right for a short Slack message,
 * where any Hangul means the asker wrote Korean — a document is judged by the
 * dominant script of its prose. An English document quoting a single Korean
 * term stays English; a Korean document peppered with English identifiers,
 * code and URLs stays Korean.
 */
export function detectDocumentLanguage(markdown?: string | null): LanguageCode {
  if (!markdown) return 'en';

  const prose = stripNonProse(markdown);
  const hangul = count(prose, HANGUL_SYLLABLES);
  const kana = count(prose, KANA);
  const han = count(prose, HAN);
  const latin = count(prose, LATIN);

  const cjk = hangul + kana + han;
  if (cjk * CJK_DENSITY_WEIGHT <= latin) return 'en';

  if (hangul > 0 && hangul >= kana) return 'ko';
  if (kana > 0) return 'ja';
  if (han > 0) return 'zh';
  return 'en';
}

const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  ko: 'Korean',
  ja: 'Japanese',
  zh: 'Chinese',
  en: 'English',
};

/** The English name of a language code, for use inside prompts. */
export function languageName(language: LanguageCode): string {
  return LANGUAGE_NAMES[language];
}
