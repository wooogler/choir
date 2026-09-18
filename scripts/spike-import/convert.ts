/**
 * P0 measurement 2 — real PDF → markdown conversions through the Responses API.
 *
 *   npx tsx scripts/spike-import/convert.ts <case> [<case> …]
 *   npx tsx scripts/spike-import/convert.ts --list
 *
 * Each case records wall time, usage (input / cached / output / reasoning),
 * cost at the tier used, and a fidelity score: the fraction of the source's
 * distinct character 5-grams (pdfjs text, NFKC + lowercase + punctuation and
 * whitespace stripped) that survive in the output markdown.
 *
 * Markdown lands in scripts/spike-import/out/, metrics append to
 * scripts/spike-import/out/metrics.jsonl so a human can read both.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { SCAN_PROMPT, TRANSCRIBE_PROMPT } from './prompt';
import {
  OUT_DIR,
  SAMPLES_DIR,
  SCRATCH,
  costUsd,
  ensureDirs,
  fidelity,
  fileToDataUrl,
  fmt,
  openaiClient,
  readPdf,
  slicePdf,
  stripFence,
} from './spike-common';

const SPEC = '/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf';
const MODEL = 'gpt-5.4-mini';

interface Case {
  id: string;
  src: string;
  /** 1-based inclusive page range; omitted = whole file */
  range?: [number, number];
  detail: 'low' | 'high';
  tier: 'flex' | 'default';
  /** use the scan-aware prompt variant instead of the plain transcription one */
  scanPrompt?: boolean;
  note: string;
}

const CASES: Case[] = [
  {
    id: 'spec-p1-5-low-flex',
    src: SPEC,
    range: [1, 5],
    detail: 'low',
    tier: 'flex',
    note: 'text PDF, low detail, flex tier',
  },
  {
    id: 'spec-p1-5-high',
    src: SPEC,
    range: [1, 5],
    detail: 'high',
    tier: 'default',
    note: 'same pages, high detail, standard tier',
  },
  {
    id: 'spec-full-low-flex',
    src: SPEC,
    detail: 'low',
    tier: 'flex',
    note: '19 pages in one call — does it finish, and how slow',
  },
  {
    id: 'table-low-flex',
    src: path.join(SAMPLES_DIR, 'table-heavy.pdf'),
    detail: 'low',
    tier: 'flex',
    note: 'table-heavy 4p, low detail',
  },
  {
    id: 'image-high-flex',
    src: path.join(SAMPLES_DIR, 'image-only.pdf'),
    detail: 'high',
    tier: 'flex',
    note: 'no text layer at all — can it read the picture',
  },
  {
    id: 'image-high-scanprompt',
    src: path.join(SAMPLES_DIR, 'image-only.pdf'),
    detail: 'high',
    tier: 'flex',
    scanPrompt: true,
    note: 'same file, prompt told to transcribe scanned pages',
  },
  {
    id: 'vector-high-flex',
    src: '/home/sangwonlee/log-analysis/venv/lib/python3.12/site-packages/matplotlib/mpl-data/images/matplotlib.pdf',
    detail: 'high',
    tier: 'flex',
    note: 'vector-only figure, no text layer',
  },
];

function buildRequest(c: Case, filename: string, dataUrl: string, tier: 'flex' | 'default') {
  return {
    model: MODEL,
    input: [
      {
        role: 'user' as const,
        content: [
          { type: 'input_text', text: c.scanPrompt ? SCAN_PROMPT : TRANSCRIBE_PROMPT },
          // `detail` is valid on the wire; the 4.104 SDK types do not know it yet
          { type: 'input_file', filename, file_data: dataUrl, detail: c.detail } as any,
        ],
      },
    ],
    max_output_tokens: 32000,
    reasoning: { effort: 'low' as const },
    ...(tier === 'flex' ? { service_tier: 'flex' as const } : {}),
  };
}

async function runCase(client: any, c: Case) {
  ensureDirs();
  let file = c.src;
  if (c.range) {
    file = path.join(SCRATCH, `${c.id}.pdf`);
    await slicePdf(c.src, c.range[0], c.range[1], file);
  }
  const info = await readPdf(file);
  const sourceText = info.pages.map((p) => p.text).join('\n');
  const dataUrl = fileToDataUrl(file);
  const bytes = fs.statSync(file).size;

  let tier = c.tier;
  let res: any;
  const t0 = Date.now();
  try {
    res = await client.responses.create(buildRequest(c, path.basename(file), dataUrl, tier) as any);
  } catch (err: any) {
    const unavailable = err?.status === 429 || String(err?.error?.code || '').includes('resource_unavailable');
    if (tier === 'flex' && unavailable) {
      console.log(`  flex rejected (${err?.status} ${err?.error?.code}); retrying on the standard tier`);
      tier = 'default';
      res = await client.responses.create(buildRequest(c, path.basename(file), dataUrl, tier) as any);
    } else {
      throw err;
    }
  }
  const ms = Date.now() - t0;

  const raw: string = res.output_text ?? '';
  const { text: markdown, wasFenced } = stripFence(raw);
  const u = res.usage ?? {};
  const inputTokens = u.input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const reasoning = u.output_tokens_details?.reasoning_tokens ?? 0;
  const cost = costUsd(MODEL, inputTokens, outputTokens, tier);
  const score = fidelity(sourceText, markdown);

  const mdPath = path.join(OUT_DIR, `${c.id}.md`);
  fs.writeFileSync(mdPath, markdown);

  const headings = (markdown.match(/^#{1,6} /gm) || []).length;
  const tableRows = (markdown.match(/^\|/gm) || []).length;
  const figureLines = (markdown.match(/^> \[Figure/gim) || []).length;

  const metrics = {
    id: c.id,
    note: c.note,
    model: MODEL,
    detail: c.detail,
    prompt: c.scanPrompt ? 'scan-aware' : 'plain',
    tierRequested: c.tier,
    tierUsed: tier,
    serviceTierReported: res.service_tier ?? null,
    status: res.status,
    incomplete: res.incomplete_details ?? null,
    pages: info.numPages,
    bytes,
    sourceChars: sourceText.length,
    outputChars: markdown.length,
    ms,
    secondsPerPage: +(ms / 1000 / Math.max(info.numPages, 1)).toFixed(2),
    inputTokens,
    cachedTokens: cached,
    outputTokens,
    reasoningTokens: reasoning,
    costUsd: +cost.toFixed(5),
    fidelity: +score.toFixed(4),
    headings,
    tableRows,
    figureLines,
    wasFenced,
    mdPath,
  };
  fs.appendFileSync(path.join(OUT_DIR, 'metrics.jsonl'), `${JSON.stringify(metrics)}\n`);
  console.log(JSON.stringify(metrics, null, 2));
  console.log(
    `  → ${fmt(ms / 1000, 1)}s, in ${fmt(inputTokens)} / out ${fmt(outputTokens)} ` +
      `(reasoning ${fmt(reasoning)}), $${cost.toFixed(4)} on ${tier}, fidelity ${score.toFixed(3)}`,
  );
  return metrics;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--list') {
    console.log('cases:');
    for (const c of CASES) console.log(`  ${c.id.padEnd(22)} ${c.note}`);
    console.log('\nnpx tsx scripts/spike-import/convert.ts <case> [<case> …]   (or "all")');
    return;
  }
  const wanted = args[0] === 'all' ? CASES : CASES.filter((c) => args.includes(c.id));
  if (!wanted.length) throw new Error(`no case matched ${args.join(', ')}`);
  const client = await openaiClient();
  let spent = 0;
  for (const c of wanted) {
    console.log(`\n=== ${c.id} — ${c.note} ===`);
    const m = await runCase(client, c);
    spent += m.costUsd;
  }
  console.log(`\nthis run spent $${spent.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  if (err?.status) console.error('status', err.status, JSON.stringify(err.error).slice(0, 500));
  process.exit(1);
});
