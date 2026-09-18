/**
 * P0 measurement 1 — real input-token counts for `input_file` PDFs.
 *
 * Uses POST /v1/responses/input_tokens, which is free, so every combination of
 * sample × detail × model is measured rather than estimated. For each sample we
 * count both the whole file and a 1-page slice (pdf-lib copyPages) so that the
 * per-page cost can be separated from the fixed prompt overhead.
 *
 * Output: JSON to the scratchpad + a Markdown table on stdout.
 *
 * Run: npx tsx scripts/spike-import/token-counts.ts
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

const MODELS = ['gpt-5.4-mini', 'gpt-5.4'];
const DETAILS: Array<'low' | 'high'> = ['low', 'high'];

interface Sample {
  key: string;
  label: string;
  file: string;
}

function samples(): Sample[] {
  return [
    {
      key: 'spec',
      label: 'spec 19p (text)',
      file: '/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf',
    },
    { key: 'table', label: 'table-heavy 4p', file: path.join(SAMPLES_DIR, 'table-heavy.pdf') },
    { key: 'image', label: 'image-only 3p (scan-like)', file: path.join(SAMPLES_DIR, 'image-only.pdf') },
    {
      key: 'vector',
      label: 'matplotlib 1p (vector figure)',
      file: '/home/sangwonlee/log-analysis/venv/lib/python3.12/site-packages/matplotlib/mpl-data/images/matplotlib.pdf',
    },
  ].filter((s) => fs.existsSync(s.file));
}

function pdfInput(filename: string, dataUrl: string, detail: 'low' | 'high') {
  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: TRANSCRIBE_PROMPT },
        // the SDK's types for `input_file` have no `detail` yet; the API takes it
        { type: 'input_file', filename, file_data: dataUrl, detail } as any,
      ],
    },
  ];
}

function textOnlyInput() {
  return [{ role: 'user', content: [{ type: 'input_text', text: TRANSCRIBE_PROMPT }] }];
}

interface Row {
  sample: string;
  key: string;
  scope: 'full' | '1page';
  pages: number;
  charsPerPage: number;
  detail: 'low' | 'high';
  model: string;
  totalTokens: number;
  overhead: number;
  perPage: number;
}

async function main() {
  ensureDirs();
  const client = await openaiClient();
  const rows: Row[] = [];
  const overheads: Record<string, number> = {};

  for (const model of MODELS) {
    overheads[model] = await countInputTokens(client, model, textOnlyInput());
    console.log(`prompt-only overhead: ${model} = ${overheads[model]} tokens`);
  }

  for (const s of samples()) {
    const info = await readPdf(s.file);
    const totalChars = info.pages.reduce((a, p) => a + p.chars, 0);
    const charsPerPage = Math.round(totalChars / Math.max(info.numPages, 1));
    const slicePath = path.join(SCRATCH, `slice-${s.key}-p1.pdf`);
    await slicePdf(s.file, 1, 1, slicePath);

    const variants: Array<{ scope: 'full' | '1page'; file: string; pages: number; chars: number }> = [
      { scope: 'full', file: s.file, pages: info.numPages, chars: charsPerPage },
      { scope: '1page', file: slicePath, pages: 1, chars: info.pages[0]?.chars ?? 0 },
    ];

    for (const v of variants) {
      const dataUrl = fileToDataUrl(v.file);
      const bytes = fs.statSync(v.file).size;
      for (const detail of DETAILS) {
        for (const model of MODELS) {
          const t0 = Date.now();
          const tokens = await countInputTokens(client, model, pdfInput(path.basename(v.file), dataUrl, detail));
          const overhead = overheads[model];
          rows.push({
            sample: s.label,
            key: s.key,
            scope: v.scope,
            pages: v.pages,
            charsPerPage: v.chars,
            detail,
            model,
            totalTokens: tokens,
            overhead,
            perPage: Math.round((tokens - overhead) / v.pages),
          });
          console.log(
            `${s.key.padEnd(7)} ${v.scope.padEnd(6)} ${String(v.pages).padStart(2)}p ` +
              `${detail.padEnd(4)} ${model.padEnd(12)} ${String(tokens).padStart(7)} tok ` +
              `(${fmt((tokens - overhead) / v.pages)}/page, ${fmt(bytes / 1024)} KB, ${Date.now() - t0} ms)`,
          );
        }
      }
    }
  }

  const jsonPath = path.join(SCRATCH, 'token-counts.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ overheads, rows }, null, 2));

  console.log('\n| sample | scope | pages | detail | model | input tokens | per page | src chars/page |');
  console.log('| --- | --- | ---: | --- | --- | ---: | ---: | ---: |');
  for (const r of rows) {
    console.log(
      `| ${r.sample} | ${r.scope} | ${r.pages} | ${r.detail} | ${r.model} | ${fmt(r.totalTokens)} | ${fmt(r.perPage)} | ${fmt(r.charsPerPage)} |`,
    );
  }
  console.log(`\nwrote ${jsonPath}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  if (err?.status) console.error('status', err.status, JSON.stringify(err.error)?.slice(0, 400));
  process.exit(1);
});
