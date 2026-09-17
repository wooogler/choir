/**
 * Replaces byte ranges in a markdown document, leaving everything else alone.
 *
 * The Slack update path used to rebuild a whole file by re-serializing its parsed
 * tree, which meant a one-paragraph edit rewrote the entire document in the
 * serializer's dialect: ordered lists came back as bullets, nested lists were
 * flattened onto one line, setext headings and indented code blocks were
 * rewritten, YAML frontmatter was destroyed, and the trailing newline was
 * stripped. None of that was anybody's edit.
 *
 * mdast gives every block-level node a `position` with byte offsets into the
 * source it was parsed from, so a node can be replaced by slicing the original
 * text instead. That is what the anchored-update path already does by searching
 * for the original text (services/document/update-anchor.ts); this is the same
 * idea addressed by offset, for updates that carry a node id rather than an
 * anchor.
 */

export interface NodeSplice {
  /** Byte offset into the markdown, inclusive. */
  start: number;
  /** Byte offset into the markdown, exclusive. */
  end: number;
  replacement: string;
  /** Node id or similar, used only in the skip reasons. */
  label?: string;
}

export type SpliceSkipReason =
  /** start/end are not a usable range within this document. */
  | 'out-of-range'
  /**
   * The range overlaps one already accepted. A list and one of its items are
   * both addressable nodes, so a batch can legitimately contain a range that
   * contains another; splicing both would corrupt the file.
   */
  | 'overlap';

export interface SpliceResult {
  markdown: string;
  applied: NodeSplice[];
  skipped: Array<{ splice: NodeSplice; reason: SpliceSkipReason }>;
}

/**
 * Applies non-overlapping replacements, latest first so that earlier offsets stay
 * valid as the string shrinks and grows underneath them.
 *
 * Where two ranges overlap the earlier-sorted one wins and the other is reported
 * rather than applied. Refusing is the only safe answer: the caller cannot know
 * what a partially-overwritten node would mean, and silently applying both would
 * interleave two edits into nonsense.
 */
export function applyNodeSplices(markdown: string, splices: NodeSplice[]): SpliceResult {
  const skipped: Array<{ splice: NodeSplice; reason: SpliceSkipReason }> = [];
  const usable: NodeSplice[] = [];

  for (const splice of splices) {
    const valid =
      Number.isInteger(splice.start) &&
      Number.isInteger(splice.end) &&
      splice.start >= 0 &&
      splice.end >= splice.start &&
      splice.end <= markdown.length;
    if (valid) {
      usable.push(splice);
    } else {
      skipped.push({ splice, reason: 'out-of-range' });
    }
  }

  // Choosing and applying want opposite orders, so they are separate passes.
  //
  // Choose in document order, widest first, and keep whichever range reaches a
  // stretch of the document first. That makes containment resolve in favour of
  // the outer node — a list rather than one of its items — which is the edit
  // that was actually asked for, and it makes the outcome depend on the document
  // rather than on the order the caller happened to pass its updates in.
  const byDocumentOrder = [...usable].sort((a, b) => a.start - b.start || b.end - a.end);

  const accepted: NodeSplice[] = [];
  let reach = 0;
  for (const splice of byDocumentOrder) {
    // Touching is not overlapping: one range may end exactly where the next
    // begins.
    if (splice.start < reach) {
      skipped.push({ splice, reason: 'overlap' });
      continue;
    }
    accepted.push(splice);
    reach = splice.end;
  }

  // Apply last-first, so replacing one range cannot move the offsets of another.
  const applied: NodeSplice[] = [];
  let result = markdown;
  for (const splice of [...accepted].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, splice.start) + splice.replacement + result.slice(splice.end);
    applied.push(splice);
  }

  return { markdown: result, applied, skipped };
}
