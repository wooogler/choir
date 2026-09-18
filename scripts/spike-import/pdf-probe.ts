/**
 * P0 check 2 + 4: does pdfjs-dist's legacy build work on Node 22 with no canvas
 * (numPages / getTextContent / encryption / metadata), and is the `height` of
 * text items a usable heading signal?
 *
 * Run: npx tsx scripts/spike-import/pdf-probe.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { SAMPLES_DIR, ensureDirs, fmt, readPdf } from './spike-common';

const SAMPLES: Array<{ name: string; file: string }> = [
  { name: 'spec (shared-mime-info)', file: '/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf' },
  {
    name: 'matplotlib (vector figure)',
    file: '/home/sangwonlee/log-analysis/venv/lib/python3.12/site-packages/matplotlib/mpl-data/images/matplotlib.pdf',
  },
  { name: 'table-heavy (generated)', file: path.join(SAMPLES_DIR, 'table-heavy.pdf') },
  { name: 'image-only (generated)', file: path.join(SAMPLES_DIR, 'image-only.pdf') },
];

function histogram(heights: number[]) {
  const counts = new Map<number, number>();
  for (const h of heights) counts.set(h, (counts.get(h) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  ensureDirs();
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  for (const s of SAMPLES) {
    if (!fs.existsSync(s.file)) {
      origWarn(`missing sample: ${s.file}`);
      continue;
    }
    const info = await readPdf(s.file);
    const all = info.pages.flatMap((p) => p.heights);
    const hist = histogram(all);
    const dominant = hist[0];
    const larger = hist.filter(([h]) => dominant && h > dominant[0] * 1.08).sort((a, b) => a[0] - b[0]);
    const totalChars = info.pages.reduce((a, p) => a + p.chars, 0);

    origWarn(`\n=== ${s.name} ===`);
    origWarn(`file: ${s.file} (${fmt(fs.statSync(s.file).size / 1024, 1)} KB)`);
    origWarn(`pages: ${info.numPages}  encrypted: ${info.encrypted}  title: ${info.title ?? '(none)'}`);
    origWarn(`pdfjs wall time: ${info.ms} ms`);
    origWarn(
      `text chars: total ${fmt(totalChars)}, per page avg ${fmt(totalChars / Math.max(info.numPages, 1))}` +
        `, min ${fmt(Math.min(...info.pages.map((p) => p.chars)))}` +
        `, max ${fmt(Math.max(...info.pages.map((p) => p.chars)))}`,
    );
    origWarn(`pages with < 100 chars (scan-like): ${info.pages.filter((p) => p.chars < 100).length}`);
    if (dominant) {
      origWarn(
        `dominant item height: ${dominant[0]} (${dominant[1]} items, ` +
          `${fmt((dominant[1] / all.length) * 100, 1)}% of ${fmt(all.length)})`,
      );
      origWarn(
        `distinct larger heights: ${larger.length ? larger.map(([h, c]) => `${h} (${c})`).join(', ') : '(none — body size only)'}`,
      );
      origWarn(
        `all heights: ${hist
          .sort((a, b) => a[0] - b[0])
          .map(([h, c]) => `${h}×${c}`)
          .join(' ')}`,
      );
    } else {
      origWarn('no text items at all (no text layer)');
    }
    origWarn(`page 1 text head: ${JSON.stringify(info.pages[0]?.text.slice(0, 160) ?? '')}`);
  }

  console.warn = origWarn;
  const unique = [...new Set(warnings.map((w) => w.split('\n')[0]))];
  origWarn(`\n=== pdfjs console warnings (${warnings.length} total, ${unique.length} distinct) ===`);
  for (const w of unique.slice(0, 20)) origWarn(`  ${w.slice(0, 200)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
