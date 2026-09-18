/**
 * P0 follow-up — what does a fidelity score below 1.0 actually consist of?
 *
 * The table-heavy sample scored 0.916 while looking correct by eye, so this
 * prints the source n-grams that went missing, grouped into readable runs. It
 * tells us whether a low score means lost content or merely the running headers
 * and page numbers the prompt was told to drop — which decides whether 0.85 is
 * the right warning threshold.
 *
 *   npx tsx scripts/spike-import/fidelity-detail.ts <case-id> …
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { OUT_DIR, SCRATCH, fidelity, normalizeForFidelity, readPdf, slicePdf } from './spike-common';

const SAMPLES: Record<string, { src: string; range?: [number, number] }> = {
  'spec-p1-5-low-flex': { src: '/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf', range: [1, 5] },
  'spec-p1-5-high': { src: '/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf', range: [1, 5] },
  'spec-full-low-flex': { src: '/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf' },
  'table-low-flex': { src: path.join(SCRATCH, 'samples/table-heavy.pdf') },
};

async function main() {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SAMPLES);
  for (const id of ids) {
    const s = SAMPLES[id];
    if (!s) {
      console.log(`unknown case ${id}`);
      continue;
    }
    let file = s.src;
    if (s.range) {
      file = path.join(SCRATCH, `fid-${id}.pdf`);
      await slicePdf(s.src, s.range[0], s.range[1], file);
    }
    const info = await readPdf(file);
    const source = info.pages.map((p) => p.text).join('\n');
    const md = fs.readFileSync(path.join(OUT_DIR, `${id}.md`), 'utf8');

    const src = normalizeForFidelity(source);
    const out = normalizeForFidelity(md);
    const n = 5;
    const outGrams = new Set<string>();
    for (let i = 0; i + n <= out.length; i++) outGrams.add(out.slice(i, i + n));

    // mark every source position covered by a surviving n-gram, then read off
    // the uncovered runs
    const covered = new Array(src.length).fill(false);
    for (let i = 0; i + n <= src.length; i++) {
      if (outGrams.has(src.slice(i, i + n))) for (let k = i; k < i + n; k++) covered[k] = true;
    }
    const runs: string[] = [];
    let start = -1;
    for (let i = 0; i <= src.length; i++) {
      if (i < src.length && !covered[i]) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        if (i - start >= 6) runs.push(src.slice(start, i));
        start = -1;
      }
    }
    runs.sort((a, b) => b.length - a.length);
    console.log(
      `\n=== ${id} — fidelity ${fidelity(source, md).toFixed(4)}, ` +
        `${runs.length} missing runs ≥6 chars, ${runs.reduce((a, r) => a + r.length, 0)} of ${src.length} normalised chars ===`,
    );
    for (const r of runs.slice(0, 15)) console.log(`  [${r.length}] ${r.slice(0, 120)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
