import crypto from 'node:crypto';
import { type ILCSResult, LCS, diff3Merge, diffIndices } from 'node-diff3';
import { stripBanner } from './banner';

/**
 * Works out what a person changed in a Google Doc, expressed as repository
 * markdown.
 *
 * The hard part is that the two sides speak different dialects. Google's export
 * escapes punctuation (`1\.`), pads list items with hard-break spaces, and loses
 * fenced code blocks entirely; the repository has none of that. Diffing an
 * export against repository markdown therefore marks nearly every line as
 * changed, and a three-way merge across that gap is all conflict.
 *
 * So the work happens in two stages:
 *
 *  1. Find the edit in export space, where both snapshots — the baseline taken
 *     right after the last push, and the document as it stands now — went
 *     through the same converter, so its quirks cancel exactly.
 *  2. Carry that edit into repository space, using a line correspondence between
 *     the baseline and the repository markdown that produced it. Anything that
 *     cannot be placed confidently becomes a conflict for a human rather than a
 *     guess.
 */

export interface DeltaConflict {
  reason: 'unmappable' | 'code-block' | 'merge';
  /** The lines a person wrote that could not be applied automatically. */
  incoming: string[];
  /** What the repository currently has in that place, where known. */
  current?: string[];
}

export interface DeltaAsset {
  /** sha256 of the decoded bytes, used to content-address the committed file. */
  hash: string;
  contentType: string;
  extension: string;
  bytes: Buffer;
}

export interface RejectedAsset {
  reason: string;
  contentType: string;
  bytes: number;
}

export interface DeltaResult {
  /** Repository markdown with the person's edit applied where possible. */
  merged: string;
  conflicts: DeltaConflict[];
  /** Images added in Google Docs, validated and ready to commit. */
  newAssets: DeltaAsset[];
  /** Images that failed validation and were dropped, with the reason. */
  rejectedAssets: RejectedAsset[];
  /** False when the export matches the baseline: nothing to review. */
  hasChanges: boolean;
}

// ── Dialect handling ──────────────────────────────────────────────────────────

/** Punctuation Google's exporter escapes; unescaping restores plain markdown. */
const ESCAPED_PUNCTUATION = /\\([\\`*_{}[\]()#+\-.!<>=|~])/g;

/**
 * Undoes the export dialect on a line a person wrote. Applied only to the lines
 * inside an edit, never to the whole document: escapes the author put in the
 * repository on purpose must survive untouched.
 */
function unescapeExportedLine(line: string): string {
  return line.replace(ESCAPED_PUNCTUATION, '$1').replace(/[ \t]+$/, '');
}

/**
 * Reduces a line to what both dialects agree on, for alignment only. The result
 * is never written anywhere — it exists so `1\. Item  ` and `1. Item` can be
 * recognised as the same line.
 */
function alignmentKey(line: string): string {
  return line.replace(ESCAPED_PUNCTUATION, '$1').replace(/\s+/g, ' ').trim();
}

// ── Image handling ────────────────────────────────────────────────────────────

/**
 * Google's export emits images as a reference (`![alt][image3]`) plus a
 * definition holding a base64 data URL. The numbering is positional, so
 * inserting an image renumbers everything after it and every later image looks
 * changed. Re-keying both snapshots by content hash makes the numbering
 * irrelevant: an untouched image gets the same key in both.
 */
const IMAGE_DEFINITION = /^\[([^\]]+)\]:\s*<(data:([^;]+);base64,([A-Za-z0-9+/=]*))>\s*$/;

interface ImagePayload {
  contentType: string;
  base64: string;
}

function rekeyImagesByContent(markdown: string): { text: string; payloads: Map<string, ImagePayload> } {
  const payloads = new Map<string, ImagePayload>();
  const renames = new Map<string, string>();
  const kept: string[] = [];

  for (const line of markdown.split('\n')) {
    const match = IMAGE_DEFINITION.exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }
    const [, label, , contentType, base64] = match;
    const hash = crypto.createHash('sha256').update(base64).digest('hex').slice(0, 16);
    renames.set(label, hash);
    payloads.set(hash, { contentType, base64 });
    kept.push(`[img-${hash}]: <embedded-image>`);
  }

  let text = kept.join('\n');
  for (const [label, hash] of renames) {
    // Only the reference form `][label]` is rewritten, so body text that happens
    // to contain the label is left alone.
    text = text.split(`][${label}]`).join(`][img-${hash}]`);
  }

  return { text, payloads };
}

/** Raster formats only, identified by magic bytes rather than a claimed type. */
function sniffImageType(bytes: Buffer): { contentType: string; extension: string } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    bytes.length >= 6 &&
    bytes
      .subarray(0, 6)
      .toString('latin1')
      .match(/^GIF8[79]a$/)
  ) {
    return { contentType: 'image/gif', extension: 'gif' };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  return null;
}

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_ASSETS_PER_DELTA = 20;

/**
 * Turns image payloads that appeared since the baseline into files worth
 * committing.
 *
 * Everything here arrives from a document any workspace member may be able to
 * edit, so the claimed content type is ignored in favour of magic bytes, SVG is
 * refused outright (it can carry script and would be served from the docs
 * origin, which holds the session cookie), and the size limit is applied to the
 * decoded length before anything is buffered.
 */
function collectNewAssets(
  before: Map<string, ImagePayload>,
  after: Map<string, ImagePayload>,
): { assets: DeltaAsset[]; rejected: RejectedAsset[] } {
  const assets: DeltaAsset[] = [];
  const rejected: RejectedAsset[] = [];

  for (const [hash, payload] of after) {
    if (before.has(hash)) continue;

    if (assets.length >= MAX_ASSETS_PER_DELTA) {
      rejected.push({ reason: 'too many new images in one edit', contentType: payload.contentType, bytes: 0 });
      continue;
    }

    // base64 expands by 4/3, so the decoded size is knowable before decoding.
    const approximateBytes = Math.floor((payload.base64.length * 3) / 4);
    if (approximateBytes > MAX_ASSET_BYTES) {
      rejected.push({ reason: 'larger than 10MB', contentType: payload.contentType, bytes: approximateBytes });
      continue;
    }

    const bytes = Buffer.from(payload.base64, 'base64');
    const sniffed = sniffImageType(bytes);
    if (!sniffed) {
      rejected.push({
        reason: 'not a PNG, JPEG, GIF or WebP image',
        contentType: payload.contentType,
        bytes: bytes.length,
      });
      continue;
    }
    if (bytes.length > MAX_ASSET_BYTES) {
      rejected.push({ reason: 'larger than 10MB', contentType: sniffed.contentType, bytes: bytes.length });
      continue;
    }

    assets.push({
      hash: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 40),
      contentType: sniffed.contentType,
      extension: sniffed.extension,
      bytes,
    });
  }

  return { assets, rejected };
}

// ── Alignment ─────────────────────────────────────────────────────────────────

/**
 * For each baseline line, the repository line saying the same thing, or -1 when
 * the dialects have nothing in common there — which is exactly what happens
 * inside a fenced code block, since the fences do not survive the round trip.
 */
function alignBaselineToSource(baseline: string[], source: string[]): number[] {
  const mapping = new Array<number>(baseline.length).fill(-1);
  const baselineKeys = baseline.map(alignmentKey);
  const sourceKeys = source.map(alignmentKey);

  let chain: ILCSResult | null = LCS(baselineKeys, sourceKeys);
  while (chain && chain.buffer1index >= 0) {
    mapping[chain.buffer1index] = chain.buffer2index;
    chain = chain.chain;
  }

  return mapping;
}

/** Where a baseline position lands in the repository, following anchors outward. */
function projectPosition(mapping: number[], baselineIndex: number, sourceLength: number): number {
  for (let index = baselineIndex; index < mapping.length; index += 1) {
    if (mapping[index] >= 0) return mapping[index];
  }
  for (let index = baselineIndex - 1; index >= 0; index -= 1) {
    if (mapping[index] >= 0) return mapping[index] + 1;
  }
  return sourceLength;
}

/** Line ranges covered by fenced code blocks, which never survive the export. */
function fencedRanges(lines: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let openedAt: number | null = null;

  lines.forEach((line, index) => {
    if (!/^\s*(```|~~~)/.test(line)) return;
    if (openedAt === null) {
      openedAt = index;
    } else {
      ranges.push([openedAt, index]);
      openedAt = null;
    }
  });
  if (openedAt !== null) ranges.push([openedAt, lines.length - 1]);

  return ranges;
}

function intersectsFence(ranges: Array<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([from, to]) => start <= to && end >= from);
}

// ── The delta ─────────────────────────────────────────────────────────────────

export interface ExtractDeltaParams {
  /** Export taken right after the last push. */
  baseline: string;
  /** Export as the document stands now. */
  exported: string;
  /** Repository markdown that produced the baseline. */
  sourceAtPush: string;
  /** Repository markdown as it stands now, which may have moved on. */
  currentSource: string;
}

export function extractDelta(params: ExtractDeltaParams): DeltaResult {
  const baselineRekeyed = rekeyImagesByContent(stripBanner(params.baseline).body);
  const exportedRekeyed = rekeyImagesByContent(stripBanner(params.exported).body);

  const baselineLines = baselineRekeyed.text.split('\n');
  const exportedLines = exportedRekeyed.text.split('\n');
  const sourceAtPushLines = params.sourceAtPush.split('\n');

  const { assets, rejected } = collectNewAssets(baselineRekeyed.payloads, exportedRekeyed.payloads);

  const hunks = diffIndices(baselineLines, exportedLines);
  if (hunks.length === 0) {
    return {
      merged: params.currentSource,
      conflicts: [],
      newAssets: assets,
      rejectedAssets: rejected,
      hasChanges: false,
    };
  }

  const mapping = alignBaselineToSource(baselineLines, sourceAtPushLines);
  const fences = fencedRanges(sourceAtPushLines);
  const conflicts: DeltaConflict[] = [];

  // Build what the repository would look like if only this person had edited it.
  const edits: Array<{ start: number; end: number; lines: string[] }> = [];

  for (const hunk of hunks) {
    const [baselineStart, baselineLength] = hunk.buffer1;
    const incoming = (hunk.buffer2Content ?? []).map(unescapeExportedLine);

    const start = projectPosition(mapping, baselineStart, sourceAtPushLines.length);
    const end = projectPosition(mapping, baselineStart + baselineLength, sourceAtPushLines.length);

    // A replaced range whose baseline lines have no repository counterpart cannot
    // be placed: we would be guessing where the text belongs.
    const anchored =
      baselineLength === 0 ||
      Array.from({ length: baselineLength }, (_unused, offset) => mapping[baselineStart + offset]).some(
        (index) => index >= 0,
      );

    if (!anchored) {
      conflicts.push({ reason: 'unmappable', incoming });
      continue;
    }
    // Code fences are lost in the export, so an edit landing in one cannot be
    // reconstructed — the person may have been editing the code or the prose
    // around it and the export cannot tell us which.
    if (intersectsFence(fences, start, Math.max(start, end - 1))) {
      conflicts.push({ reason: 'code-block', incoming, current: sourceAtPushLines.slice(start, end) });
      continue;
    }

    edits.push({ start, end: Math.max(start, end), lines: incoming });
  }

  const theirs = applyEdits(sourceAtPushLines, edits);

  // Now both sides speak repository markdown, so a three-way merge is meaningful:
  // it reconciles this person's edit with whatever GitHub has done since.
  const merged: string[] = [];
  for (const region of diff3Merge(params.currentSource.split('\n'), sourceAtPushLines, theirs)) {
    if ('ok' in region && region.ok) {
      merged.push(...region.ok);
      continue;
    }
    if ('conflict' in region && region.conflict) {
      // Keep the repository's text and surface the person's version for review
      // rather than silently choosing one.
      merged.push(...region.conflict.a);
      conflicts.push({ reason: 'merge', incoming: region.conflict.b, current: region.conflict.a });
    }
  }

  return {
    merged: merged.join('\n'),
    conflicts,
    newAssets: assets,
    rejectedAssets: rejected,
    hasChanges: true,
  };
}

/** Applies non-overlapping replacements, latest first so earlier indices hold. */
function applyEdits(lines: string[], edits: Array<{ start: number; end: number; lines: string[] }>): string[] {
  const next = [...lines];
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    next.splice(edit.start, Math.max(0, edit.end - edit.start), ...edit.lines);
  }
  return next;
}
