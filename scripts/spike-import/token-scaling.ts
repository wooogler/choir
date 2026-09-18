/**
 * P0 measurement 1b — follow-up probe.
 *
 * The first pass produced a surprise: for the text-only spec PDF, a 1-page
 * slice costs the same at `detail: low` and `detail: high`, while the whole
 * 19-page file costs ~2.2x more at `high`. This script slices the same source
 * to 1, 2, 3, 5, 10 and 19 pages and counts each at low / high / no-detail, so
 * the per-page image cost (and any threshold behind it) becomes visible.
 *
 * Still free — /v1/responses/input_tokens is not billed.
 *
 * Run: npx tsx scripts/spike-import/token-scaling.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { TRANSCRIBE_PROMPT } from './prompt';
import {
  SAMPLES_DIR,
  SCRATCH,
  countInputTokens,
  ensureDirs,
  fileToDataUrl,
  fmt,
  openaiClient,
  readPdf,
  slicePdf,
} from './spike-common';

const MODEL = 'gpt-5.4-mini';
const SPEC = '/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf';
const TABLE = path.join(SAMPLES_DIR, 'table-heavy.pdf');
const IMAGE = path.join(SAMPLES_DIR, 'image-only.pdf');

function input(filename: string, dataUrl: string, detail?: 'low' | 'high') {
  const filePart: Record<string, unknown> = { type: 'input_file', filename, file_data: dataUrl };
  if (detail) filePart.detail = detail;
  return [
    {
      role: 'user',
      content: [{ type: 'input_text', text: TRANSCRIBE_PROMPT }, filePart],
    },
  ];
}

async function main() {
  ensureDirs();
  const client = await openaiClient();
  const overhead = await countInputTokens(client, MODEL, [
    { role: 'user', content: [{ type: 'input_text', text: TRANSCRIBE_PROMPT }] },
  ]);
  console.log(`overhead ${overhead}\n`);

  const cases: Array<{ src: string; label: string; ranges: number[] }> = [
    { src: SPEC, label: 'spec', ranges: [1, 2, 3, 5, 10, 19] },
    { src: TABLE, label: 'table', ranges: [1, 2, 4] },
    { src: IMAGE, label: 'image', ranges: [1, 2, 3] },
  ];

  const results: any[] = [];
  console.log('| source | pages | cum. text chars | no detail | low | high | high−low | (high−low)/page |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');

  for (const c of cases) {
    const info = await readPdf(c.src);
    for (const n of c.ranges) {
      const dest = path.join(SCRATCH, `scale-${c.label}-1to${n}.pdf`);
      await slicePdf(c.src, 1, n, dest);
      const dataUrl = fileToDataUrl(dest);
      const name = path.basename(dest);
      const chars = info.pages.slice(0, n).reduce((a, p) => a + p.chars, 0);
      const none = await countInputTokens(client, MODEL, input(name, dataUrl));
      const low = await countInputTokens(client, MODEL, input(name, dataUrl, 'low'));
      const high = await countInputTokens(client, MODEL, input(name, dataUrl, 'high'));
      results.push({ source: c.label, pages: n, chars, none, low, high, bytes: fs.statSync(dest).size });
      console.log(
        `| ${c.label} | ${n} | ${fmt(chars)} | ${fmt(none)} | ${fmt(low)} | ${fmt(high)} | ${fmt(high - low)} | ${fmt((high - low) / n)} |`,
      );
    }
  }

  fs.writeFileSync(path.join(SCRATCH, 'token-scaling.json'), JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
