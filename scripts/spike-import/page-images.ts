/**
 * P0 measurement 1d — which pages actually carry an embedded raster image?
 *
 * The per-page token probe showed that only spec pages 4,5,6,7,10,12 cost extra
 * at `detail: high` (a flat +1,881 each) while every other page costs its text
 * and nothing else. If those are exactly the pages with an embedded image
 * XObject, then `input_file` is not rasterising pages at all — it extracts the
 * text layer plus the images already embedded in the file. That changes what
 * `detail` buys us.
 *
 * Pure pdfjs, no API calls. Run: npx tsx scripts/spike-import/page-images.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { SAMPLES_DIR } from './spike-common';

const TARGETS = [
  { label: 'spec', file: '/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf' },
  { label: 'table-heavy', file: path.join(SAMPLES_DIR, 'table-heavy.pdf') },
  { label: 'image-only', file: path.join(SAMPLES_DIR, 'image-only.pdf') },
  {
    label: 'matplotlib',
    file: '/home/sangwonlee/log-analysis/venv/lib/python3.12/site-packages/matplotlib/mpl-data/images/matplotlib.pdf',
  },
];

/** width/height of a PNG file, straight out of the IHDR chunk. */
function pngSize(file: string): { w: number; h: number } | null {
  if (!fs.existsSync(file)) return null;
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

async function main() {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const OPS = pdfjs.OPS;
  const OP_NAMES: Record<number, string> = {};
  for (const [name, value] of Object.entries(OPS)) OP_NAMES[value as number] = name;
  const imageOps = new Set(
    ['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintJpegXObject']
      .map((n) => OPS[n])
      .filter((v) => v !== undefined),
  );

  for (const t of TARGETS) {
    if (!fs.existsSync(t.file)) continue;
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(fs.readFileSync(t.file)),
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;
    const withImages: Array<{ page: number; count: number; dims: string[] }> = [];
    const perPageOps: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const ops = await page.getOperatorList();
      let count = 0;
      const dims: string[] = [];
      const opNames = new Map<string, number>();
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const name = OP_NAMES[fn] ?? String(fn);
        opNames.set(name, (opNames.get(name) || 0) + 1);
        if (!imageOps.has(fn)) continue;
        count++;
        const arg = ops.argsArray[i]?.[0];
        dims.push(typeof arg === 'string' ? arg : arg?.width ? `${arg.width}x${arg.height}` : '?');
      }
      const drawing = [...opNames.entries()]
        .filter(([n]) =>
          /^(fill|stroke|constructPath|shadingFill|paint|setFillRGB|setStrokeRGB|eoFill|closePath)/i.test(n),
        )
        .map(([n, c]) => `${n}:${c}`)
        .join(' ');
      perPageOps.push(`  p${String(p).padStart(2)} ops=${ops.fnArray.length} ${drawing || '(text only)'}`);
      if (count) withImages.push({ page: p, count, dims });
    }
    console.log(
      `${t.label}: ${doc.numPages} pages; pages with embedded images: ${withImages.length ? withImages.map((w) => `${w.page} (${w.count}× ${w.dims.join(',')})`).join(', ') : 'none'}`,
    );
    if (process.env.SPIKE_OPS) console.log(perPageOps.join('\n'));
  }

  const src = process.env.SPIKE_PNG || '/usr/share/info/gnupg-module-overview.png';
  const size = pngSize(src);
  if (size) console.log(`\nsource PNG for image-only.pdf: ${src} = ${size.w}x${size.h}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
