export type InlineSegment = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
};

type Style = Omit<InlineSegment, 'text'>;

// Emphasis inside emphasis inside a link is already more nesting than a heading
// needs; past this the remaining markers are shown as literal text.
const MAX_DEPTH = 8;

// A link destination: bare (no whitespace, no parentheses), or angle-bracketed,
// with an optional title. Deliberately strict — `[a](b c.md)` is not a link in
// CommonMark, and unwrapping it here would leave the label saying something the
// rendered heading does not.
const DESTINATION = String.raw`\(\s*(?:<[^<>\n]*>|[^\s()]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)`;

// One pass over the inline constructs a heading can carry, longest delimiter
// first so `***` beats `**` beats `*`.
//
// The emphasis bodies are written as unambiguous alternations — an escape pair,
// the one delimiter that may nest, or a character that is neither a backslash
// nor a delimiter — so a body has exactly one way to match. That keeps the lazy
// quantifier linear (no backtracking blowup on a heading full of markers), and
// it is what lets `*a **b** c*` keep its inner run instead of stopping at the
// first asterisk it meets.
const TOKEN_SOURCE = new RegExp(
  [
    // Only ASCII punctuation is escapable; `\d` is two literal characters.
    String.raw`(?<escaped>\\[!-\/:-@\[-\`{-~])`,
    String.raw`(?<ticks>\`+)(?<code>[\s\S]*?)\k<ticks>`,
    // An image contributes nothing to the heading's text — its alt lives in an
    // attribute — so it is matched only to be dropped.
    String.raw`!\[(?<image>[^\]]*)\]${DESTINATION}`,
    String.raw`\[(?<link>[^\]]*)\]${DESTINATION}`,
    String.raw`\*\*\*(?=\S)(?<bothStar>(?:\\.|[^\\*])+?)(?<!\s)\*\*\*`,
    String.raw`(?<!\w)___(?=\S)(?<bothUnderscore>(?:\\.|[^\\_])+?)(?<!\s)___(?!\w)`,
    String.raw`\*\*(?=\S)(?<strongStar>(?:\\.|\*(?!\*)|[^\\*])+?)(?<!\s)\*\*`,
    String.raw`(?<!\w)__(?=\S)(?<strongUnderscore>(?:\\.|_(?!_)|[^\\_])+?)(?<!\s)__(?!\w)`,
    String.raw`~~(?=\S)(?<strike>(?:\\.|~(?!~)|[^\\~])+?)(?<!\s)~~`,
    String.raw`\*(?!\*)(?=\S)(?<emphasisStar>(?:\\.|\*\*|[^\\*])+?)(?<!\s)\*(?!\*)`,
    // Underscore emphasis is refused mid-word, so `snake_case_name` stays literal.
    String.raw`(?<!\w)_(?!_)(?=\S)(?<emphasisUnderscore>(?:\\.|__|[^\\_])+?)(?<!\s)_(?!_)(?!\w)`,
  ].join('|'),
  'g',
);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  rdquo: '”',
  rsquo: '’',
};

/**
 * Resolves the character references a renderer resolves.
 *
 * Documents exported from Google Docs carry `&nbsp;` and `&amp;` routinely, and
 * a label still spelling them would not match the heading it names.
 */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;

  return text.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** CommonMark strips one space from each end, but only when both ends have one. */
function trimCodeSpan(text: string): string {
  if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') {
    return text.slice(1, -1);
  }
  return text;
}

function walk(source: string, style: Style, out: InlineSegment[], depth = 0): void {
  // A fresh matcher per call: `walk` recurses into the text it just matched, and
  // a shared /g regex would carry its lastIndex into (and out of) that recursion.
  const token = new RegExp(TOKEN_SOURCE.source, 'g');
  let cursor = 0;

  const emit = (text: string) => out.push({ ...style, text: decodeEntities(text) });

  for (let match = token.exec(source); match; match = token.exec(source)) {
    if (match.index > cursor) emit(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const groups = match.groups ?? {};
    const both = groups.bothStar ?? groups.bothUnderscore;
    const strong = groups.strongStar ?? groups.strongUnderscore;
    const emphasis = groups.emphasisStar ?? groups.emphasisUnderscore;

    if (groups.escaped !== undefined) out.push({ ...style, text: groups.escaped.slice(1) });
    else if (groups.code !== undefined) out.push({ ...style, code: true, text: trimCodeSpan(groups.code) });
    else if (groups.image !== undefined) {
      // Nothing: the heading reads as if the image were not there, which is what
      // its rendered text says too.
    } else if (depth >= MAX_DEPTH) emit(match[0]);
    else if (groups.link !== undefined) walk(groups.link, style, out, depth + 1);
    else if (both !== undefined) walk(both, { ...style, bold: true, italic: true }, out, depth + 1);
    else if (strong !== undefined) walk(strong, { ...style, bold: true }, out, depth + 1);
    else if (groups.strike !== undefined) walk(groups.strike, { ...style, strike: true }, out, depth + 1);
    else if (emphasis !== undefined) walk(emphasis, { ...style, italic: true }, out, depth + 1);
  }

  if (cursor < source.length) emit(source.slice(cursor));
}

function sameStyle(left: InlineSegment, right: InlineSegment): boolean {
  return (
    Boolean(left.bold) === Boolean(right.bold) &&
    Boolean(left.italic) === Boolean(right.italic) &&
    Boolean(left.code) === Boolean(right.code) &&
    Boolean(left.strike) === Boolean(right.strike)
  );
}

/**
 * Splits heading text into styled runs, so the outline can show the emphasis a
 * heading carries rather than the asterisks that spell it.
 *
 * The runs joined together are what the rendered heading's textContent says —
 * the contract `slugifyHeading` relies on to match an outline entry to the
 * heading it points at.
 */
export function parseInlineMarkdown(source: string): InlineSegment[] {
  const raw: InlineSegment[] = [];
  walk(source, {}, raw);

  const merged: InlineSegment[] = [];
  for (const segment of raw) {
    if (!segment.text) continue;
    const previous = merged[merged.length - 1];
    if (previous && sameStyle(previous, segment)) previous.text += segment.text;
    else merged.push({ ...segment });
  }
  return merged;
}

/** The same text with the markers dropped — used for slugs, titles, and search. */
export function inlineMarkdownToText(source: string): string {
  return parseInlineMarkdown(source)
    .map((segment) => segment.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
