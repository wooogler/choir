import type { ConvertedDocument, ImportAsset } from './types';
import { ImportRefusal } from './types';

/**
 * What may be committed from a draft the manager has edited.
 *
 * The preview hands back markdown the client rewrote, but the images are ours:
 * they were fetched, validated and content-addressed during conversion and live
 * only in the draft. So the body cannot be trusted to name them. Two rules, both
 * enforced here rather than at the landing site:
 *
 * - A body reference to `assets/…` that the draft does not hold is removed. It
 *   is either a typo or an attempt to point the new document at some other
 *   document's binary; committing it would produce a broken image either way.
 * - A draft asset nobody references any more is not committed. Deleting an image
 *   in the preview has to actually delete it, or the repository accumulates
 *   binaries no document shows.
 *
 * Pure: no I/O, no clock. Everything it needs is the edited markdown and the
 * draft it came from.
 */

export interface PrepareCommitParams {
  /** The manager's edited body, as the preview returned it. */
  markdown: string;
  /** The draft this body was converted from. */
  document: ConvertedDocument;
}

export interface PreparedCommit {
  /** The body with unbacked `assets/…` references taken out. */
  markdown: string;
  /** Exactly the draft assets the body still shows. */
  assets: ImportAsset[];
  /** Normalized paths that were referenced but not held, in the order they appeared. */
  droppedReferences: string[];
}

/**
 * The one spelling an asset path is compared and committed as.
 *
 * Editors write image destinations three ways — `./assets/x.png` from a
 * relative-path habit, `/assets/x.png` from a web habit, `assets/x.png` as we
 * emit them — and all three mean the repository-root `assets/` directory,
 * because an imported document's assets always land there.
 */
export function normalizeAssetPath(target: string): string {
  const trimmed = target.trim().replace(/^<|>$/g, '');
  return trimmed.replace(/^\.?\//, '');
}

export function isAssetReference(normalized: string): boolean {
  return normalized.startsWith('assets/');
}

/** `![alt](target)` and `![alt](target "title")`, with an optional `<…>` destination. */
const INLINE_IMAGE = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

/** `![alt][id]` and the collapsed `![alt][]`, whose id is the alt text. */
const REFERENCE_IMAGE = /!\[([^\]]*)\]\[([^\]]*)\]/g;

/** `[id]: target "title"` — a link reference definition on its own line. */
const DEFINITION_LINE = /^ {0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

export function prepareCommit({ markdown, document }: PrepareCommitParams): PreparedCommit {
  if (markdown.trim().length === 0) {
    throw new ImportRefusal(400, 'import_empty');
  }

  const held = new Set(document.assets.map((asset) => normalizeAssetPath(asset.path)));
  const definitions = collectDefinitions(markdown);

  const referenced = new Set<string>();
  const dropped: string[] = [];

  // A destination is either kept as written or reported once: `decide` is the
  // only place that judges, so inline and reference-style images cannot drift.
  const decide = (target: string): boolean => {
    const normalized = normalizeAssetPath(target);
    if (!isAssetReference(normalized)) return true;
    if (held.has(normalized)) {
      referenced.add(normalized);
      return true;
    }
    if (!dropped.includes(normalized)) dropped.push(normalized);
    return false;
  };

  const rewritten = mapProse(markdown, (line) => {
    const withoutInline = line.replace(INLINE_IMAGE, (match, alt: string, target: string) =>
      decide(target) ? match : fallbackText(alt),
    );

    const withoutReference = withoutInline.replace(REFERENCE_IMAGE, (match, alt: string, id: string) => {
      const target = definitions.get(definitionKey(id || alt));
      // An id with no definition is not an image at all — markdown renders it as
      // literal text — so it is none of our business.
      if (target === undefined) return match;
      return decide(target) ? match : fallbackText(alt);
    });

    // The definition itself goes too, or the document keeps a dangling pointer
    // to a binary that was never committed.
    const definition = DEFINITION_LINE.exec(withoutReference);
    if (definition) {
      const normalized = normalizeAssetPath(definition[2]);
      if (isAssetReference(normalized) && !held.has(normalized)) return null;
    }

    return withoutReference;
  });

  const assets = document.assets.filter((asset) => referenced.has(normalizeAssetPath(asset.path)));

  // Only a document we actually cut is re-flowed: collapsing blank lines is a
  // repair for the holes we made, not a licence to reformat someone's writing.
  const cleaned = dropped.length > 0 ? collapseBlankLines(rewritten) : rewritten;

  return { markdown: cleaned, assets, droppedReferences: dropped };
}

/** Alt text survives as prose when there is any; an empty alt leaves nothing behind. */
function fallbackText(alt: string): string {
  return alt.trim().length > 0 ? alt : '';
}

/** Reference definitions are case-insensitive and whitespace-collapsed in CommonMark. */
function definitionKey(id: string): string {
  return id.trim().replace(/\s+/g, ' ').toLowerCase();
}

function collectDefinitions(markdown: string): Map<string, string> {
  const definitions = new Map<string, string>();
  mapProse(markdown, (line) => {
    const match = DEFINITION_LINE.exec(line);
    // First definition wins, as it does in CommonMark.
    if (match && !definitions.has(definitionKey(match[1]))) {
      definitions.set(definitionKey(match[1]), match[2]);
    }
    return line;
  });
  return definitions;
}

/**
 * Runs `transform` over the lines that are prose, leaving fenced code blocks
 * exactly as written. A code sample showing `![](assets/x.png)` is text about
 * markdown, not a reference to a binary, and rewriting it would corrupt the very
 * thing the author was documenting. Returning `null` deletes the line.
 */
function mapProse(markdown: string, transform: (line: string) => string | null): string {
  const out: string[] = [];
  let fence: string | null = null;

  for (const line of markdown.split('\n')) {
    const marker = FENCE_LINE.exec(line);

    if (fence) {
      out.push(line);
      // A closing fence is nothing but fence characters of the opening kind.
      const closing = line.trim();
      if (closing.startsWith(fence) && /^(`+|~+)$/.test(closing)) fence = null;
      continue;
    }

    if (marker) {
      fence = marker[1];
      out.push(line);
      continue;
    }

    const next = transform(line);
    if (next !== null) out.push(next);
  }

  return out.join('\n');
}

/**
 * Three or more newlines is a hole where an image used to be, not a paragraph
 * break. Lines left holding only the indentation of a removed image count as
 * blank; every other line keeps its trailing spaces, which in markdown are a
 * hard line break the author may have meant.
 */
function collapseBlankLines(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => (line.trim().length === 0 ? '' : line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}
