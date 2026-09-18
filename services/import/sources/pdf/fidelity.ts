/**
 * How much of the PDF's own text survived into the markdown.
 *
 * The failure mode this guards against is a model that writes a *good* document
 * instead of the one it was given: a summary reads fine and passes every
 * structural check. Character n-grams catch it because a summary cannot keep the
 * source's exact wording at that granularity, while reordering, re-wrapping,
 * table formatting and dropped page furniture leave the score alone.
 *
 * Deliberately not a gate — the score becomes a `low_fidelity` warning and a
 * human decides in the preview. See docs/pdf-web-import.md, 결정 4.
 */

const GRAM_SIZE = 5;

/**
 * Removes the markup the model added so the comparison sees text against text.
 * Link and image targets go entirely: a URL is output the source never had, and
 * leaving it in could only ever create accidental matches.
 */
export function stripMarkdownSyntax(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, ' ')
    .replace(/^\s{0,3}>\s?/gm, ' ')
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, ' ')
    .replace(/^\s*\|?[\s:|-]*\|[\s:|-]*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/[*_~]/g, ' ');
}

/**
 * NFKC first so full-width and compatibility forms compare equal to their plain
 * counterparts, then everything that is not a letter or a digit goes: whitespace
 * and punctuation are exactly what re-wrapping and table syntax move around.
 */
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Fraction of the source's character 5-grams that appear in the markdown, in [0, 1]. */
export function fidelityScore(sourceText: string, markdown: string): number {
  const source = normalize(sourceText);
  // Nothing (or almost nothing) to compare against: a scanned page has no text
  // layer, and refusing to score is honest where scoring zero would not be.
  if (source.length < GRAM_SIZE) return 1;

  // Both sides are indexed as gram sets rather than scanning the output per
  // gram: a 200-page document has hundreds of thousands of grams, and the naive
  // substring search is quadratic in the length of the document.
  const output = collectGrams(normalize(stripMarkdownSyntax(markdown)));
  const grams = collectGrams(source);

  let found = 0;
  for (const gram of grams) {
    if (output.has(gram)) found += 1;
  }
  return found / grams.size;
}

function collectGrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + GRAM_SIZE <= text.length; i += 1) {
    grams.add(text.slice(i, i + GRAM_SIZE));
  }
  return grams;
}
