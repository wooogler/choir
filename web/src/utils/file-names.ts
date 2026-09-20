/**
 * Naming a new file the way the folder already names its files.
 *
 * Every folder in a documentation repository has picked a convention long
 * before anybody writes it down: `2026-09-13-weekly-sync.md` in the meeting
 * notes, `01-onboarding.md` in a guide that is meant to be read in order,
 * `Weekly_Sync_0913.md` wherever the first file came out of somebody's laptop.
 * A suggestion that ignores the convention is worse than no suggestion — the
 * new file lands out of place in a sorted list and stays there.
 *
 * So the suggestion is read off the siblings rather than invented: the
 * dominant prefix (a date, a running number, or neither), the separator that
 * prefix uses, the separator between words, and whether the folder writes in
 * lower case. "Dominant" means a strict majority — a folder that has not made
 * up its mind gets a plain name rather than a guess dressed up as a rule.
 *
 * Pure, and tested as such in `__tests__/web-file-names.test.ts`: the callers
 * (the new-document and rename dialogs) only put the answer in a placeholder.
 */

/** The shape the folder's names take, once the siblings have voted. */
export type FileNamePattern = 'date' | 'number' | 'plain';

export interface FileNameSuggestion {
  /** The basename, `.md` included. The caller prefixes the folder. */
  placeholder: string;
  pattern: FileNamePattern;
  /** Up to three siblings, the ones that read as the folder's latest. */
  examples: string[];
}

export interface FileNameSuggestionOptions {
  title: string;
  /** The date a date-named folder should stamp on; today when absent. */
  date?: Date;
  /** The slug to use when the title is empty (or entirely punctuation). */
  fallback: string;
}

const MARKDOWN = /\.md$/i;

/** What a folder can put between words. Anything else is normalised to these. */
type WordSeparator = '-' | '_';

interface DatePrefix {
  /** What separates the date's own parts: '' for `20260913`, else `-`, `.`, `_`. */
  sep: string;
  /** What separates the date from the rest of the name; '' when there is none. */
  gap: string;
  rest: string;
  /** `YYYYMMDD`, for sorting siblings without parsing them twice. */
  key: string;
}

interface NumberPrefix {
  /** Digits as written, so `001` keeps its padding. */
  width: number;
  value: number;
  gap: string;
  rest: string;
}

interface Sibling {
  name: string;
  stem: string;
  date: DatePrefix | null;
  number: NumberPrefix | null;
}

function stemOf(name: string): string {
  return name.replace(MARKDOWN, '');
}

/**
 * `YYYY-MM-DD`, `YYYYMMDD`, `YYYY.MM.DD`, `YYYY_MM_DD` — one separator, used
 * consistently (the backreference), and a month and day that could be real.
 * The year window keeps `1234-5678-notes.md` out: that is a number, not a date.
 */
function readDatePrefix(stem: string): DatePrefix | null {
  const match = stem.match(/^(\d{4})([-._]?)(\d{2})\2(\d{2})(.*)$/);
  if (!match) return null;

  const [, year, sep, month, day, tail] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > 31) return null;

  // Digits running straight on (`2026091399`) are not a dated name.
  if (tail && !/^[-._ ]/.test(tail)) return null;

  return { sep, gap: tail ? tail[0] : '', rest: tail ? tail.slice(1) : '', key: `${year}${month}${day}` };
}

/** `01-onboarding`, `1_intro`, `001.setup` — digits, a separator, then a name. */
function readNumberPrefix(stem: string): NumberPrefix | null {
  const match = stem.match(/^(\d{1,6})([-._ ])(.+)$/);
  if (!match) return null;
  return { width: match[1].length, value: Number(match[1]), gap: match[2], rest: match[3] };
}

function mostCommon(values: string[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  let best = fallback;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * A title → the word part of a filename, in the folder's separator and case.
 *
 * Hangul is kept as it is, exactly as `suggestFileName` keeps it: these
 * repositories are full of Korean filenames and transliterating them would
 * produce a name nobody could search for.
 */
function slugify(title: string, separator: WordSeparator, keepCase: boolean): string {
  const source = keepCase ? title : title.toLowerCase();
  const group = separator === '-' ? '\\-' : '_';
  return (
    source
      .replace(/[^a-zA-Z0-9가-힣]+/g, separator)
      .replace(new RegExp(`^[${group}]+|[${group}]+$`, 'g'), '')
      .slice(0, 80)
      // The slice can land mid-separator; a name never ends in one.
      .replace(new RegExp(`[${group}]+$`), '')
  );
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function stamp(when: Date, sep: string): string {
  const year = String(when.getFullYear());
  const month = pad(when.getMonth() + 1, 2);
  const day = pad(when.getDate(), 2);
  return `${year}${sep}${month}${sep}${day}`;
}

/**
 * The name to offer for a new file in a folder that already holds `siblings`
 * (basenames, `.md` included — anything else is ignored).
 *
 * An empty title keeps the folder's prefix and uses `fallback` for the word
 * part: in a dated folder `2026-09-20-untitled.md` is still in the right place,
 * which a bare `untitled.md` would not be.
 */
export function suggestFileNameFromSiblings(siblings: string[], opts: FileNameSuggestionOptions): FileNameSuggestion {
  const parsed: Sibling[] = siblings
    .map((name) => name.trim())
    .filter((name) => MARKDOWN.test(name))
    .map((name) => {
      const stem = stemOf(name);
      const date = readDatePrefix(stem);
      return { name, stem, date, number: date ? null : readNumberPrefix(stem) };
    });

  const dated = parsed.filter((item): item is Sibling & { date: DatePrefix } => item.date !== null);
  const numbered = parsed.filter((item): item is Sibling & { number: NumberPrefix } => item.number !== null);

  // Strict majority, so a folder holding one dated file among five plain ones
  // is read as plain rather than as a calendar.
  const isMajority = (count: number) => count * 2 > parsed.length;
  const pattern: FileNamePattern = isMajority(dated.length) ? 'date' : isMajority(numbered.length) ? 'number' : 'plain';

  // The separator and the case are read off the part of the name that carries
  // the words, so a `2026-09-13_weekly_sync.md` folder is heard saying `_`.
  const wordParts = parsed.map((item) => {
    if (pattern === 'date' && item.date) return item.date.rest;
    if (pattern === 'number' && item.number) return item.number.rest;
    return item.stem;
  });
  // The character joining the prefix to the words counts as a vote too: a
  // folder of `2026.09.06_sync.md` has no separator *inside* its word part at
  // all, and `_` is plainly what it would put there.
  const gaps =
    pattern === 'date'
      ? dated.map((item) => item.date.gap)
      : pattern === 'number'
        ? numbered.map((item) => item.number.gap)
        : [];
  const votes = [...wordParts, ...gaps];
  const dashes = votes.reduce((total, part) => total + (part.match(/-/g)?.length ?? 0), 0);
  const underscores = votes.reduce((total, part) => total + (part.match(/_/g)?.length ?? 0), 0);
  const separator: WordSeparator = underscores > dashes ? '_' : '-';
  const upperCased = wordParts.filter((part) => /[A-Z]/.test(part)).length;
  const keepCase = upperCased * 2 > wordParts.length;

  const slug = slugify(opts.title, separator, keepCase) || opts.fallback;

  let placeholder: string;
  let examples: string[];

  if (pattern === 'date') {
    const dateSep = mostCommon(
      dated.map((item) => item.date.sep),
      '-',
    );
    const gap = mostCommon(dated.map((item) => item.date.gap).filter(Boolean), separator);
    placeholder = `${stamp(opts.date ?? new Date(), dateSep)}${gap}${slug}.md`;
    examples = [...dated]
      .sort((left, right) => right.date.key.localeCompare(left.date.key) || right.name.localeCompare(left.name))
      .slice(0, 3)
      .map((item) => item.name);
  } else if (pattern === 'number') {
    const width = Math.max(...numbered.map((item) => item.number.width));
    const next = Math.max(...numbered.map((item) => item.number.value)) + 1;
    const gap = mostCommon(
      numbered.map((item) => item.number.gap),
      separator,
    );
    placeholder = `${pad(next, width)}${gap}${slug}.md`;
    examples = [...numbered]
      .sort((left, right) => right.number.value - left.number.value || right.name.localeCompare(left.name))
      .slice(0, 3)
      .map((item) => item.name);
  } else {
    placeholder = `${slug}.md`;
    // No key to sort by, so "latest" is the end of the alphabet — which is
    // where a name carrying a trailing date or number ends up anyway.
    examples = parsed
      .map((item) => item.name)
      .sort((left, right) => left.localeCompare(right))
      .slice(-3);
  }

  return { placeholder, pattern, examples };
}
