/**
 * P0 measurement 1c — per-page probe.
 *
 * The scaling probe showed that `detail: high` adds nothing for spec pages 1-3
 * but a lot for pages 4-10. This slices every page of the spec on its own and
 * counts it at low and high, so we can see exactly which pages carry a
 * rasterised page image and what one costs.
 *
 * Free endpoint. Run: npx tsx scripts/spike-import/token-per-page.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { TRANSCRIBE_PROMPT } from './prompt';
import {
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
const SPEC = process.env.SPIKE_PDF || '/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf';

function input(filename: string, dataUrl: string, detail: 'low' | 'high') {
  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: TRANSCRIBE_PROMPT },
        { type: 'input_file', filename, file_data: dataUrl, detail } as any,
      ],
    },
  ];
}

async function main() {
  ensureDirs();
  const client = await openaiClient();
  const overhead = await countInputTokens(client, MODEL, [
    { role: 'user', content: [{ type: 'input_text', text: TRANSCRIBE_PROMPT }] },
  ]);
  const info = await readPdf(SPEC);
  const rows: any[] = [];

  console.log('| page | text chars | low | high | high−low | tok/char (low) |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: |');
  for (let p = 1; p <= info.numPages; p++) {
    const dest = path.join(SCRATCH, `page-${p}.pdf`);
    await slicePdf(SPEC, p, p, dest);
    const dataUrl = fileToDataUrl(dest);
    const name = path.basename(dest);
    const low = await countInputTokens(client, MODEL, input(name, dataUrl, 'low'));
    const high = await countInputTokens(client, MODEL, input(name, dataUrl, 'high'));
    const chars = info.pages[p - 1].chars;
    rows.push({ page: p, chars, low, high, net: low - overhead, delta: high - low });
    console.log(
      `| ${p} | ${fmt(chars)} | ${fmt(low)} | ${fmt(high)} | ${fmt(high - low)} | ${((low - overhead) / Math.max(chars, 1)).toFixed(3)} |`,
    );
  }
  fs.writeFileSync(path.join(SCRATCH, 'token-per-page.json'), JSON.stringify({ overhead, rows }, null, 2));
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
