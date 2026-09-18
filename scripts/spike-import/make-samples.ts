/**
 * Generates the two synthetic sample PDFs the spike needs, into the scratchpad:
 *
 *   table-heavy.pdf  — 4 pages of dense Helvetica tables (stands in for a
 *                      table-heavy English document)
 *   image-only.pdf   — 3 pages, each a full-page PNG and no text layer at all
 *                      (stands in for a scanned document)
 *
 * Run: npx tsx scripts/spike-import/make-samples.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { SAMPLES_DIR, ensureDirs } from './spike-common';

const IMAGE_SOURCE = process.env.SPIKE_PNG || '/usr/share/info/gnupg-module-overview.png';

const HEADERS = ['ID', 'Component', 'Owner', 'Status', 'Latency (ms)', 'Notes'];
const COMPONENTS = [
  'ingest-worker',
  'vector-store',
  'slack-gateway',
  'github-sync',
  'qmd-index',
  'draft-store',
  'mirror-cache',
  'oauth-bridge',
  'reranker',
  'embed-queue',
  'pdf-gate',
  'web-fetcher',
  'i18n-loader',
  'audit-log',
  'metrics-pump',
];
const OWNERS = ['platform', 'search', 'integrations', 'infra'];
const STATUSES = ['healthy', 'degraded', 'draining', 'healthy'];
const NOTES = [
  'nominal',
  'retry budget 3',
  'flex tier',
  'backfill pending',
  'cold start 1.2s',
  'rate limited 09:00',
  'pinned to us-east',
  'n/a',
];

async function makeTablePdf(dest: string) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle('Service Inventory Report');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const width = 612;
  const height = 792;
  const left = 48;
  const colWidths = [46, 118, 86, 78, 86, 102];
  const rowHeight = 18;

  for (let p = 0; p < 4; p++) {
    const page = doc.addPage([width, height]);
    let y = height - 56;

    page.drawText('Service Inventory Report', { x: left, y, size: 18, font: bold });
    y -= 26;
    page.drawText(`Section ${p + 1}. Quarterly review of runtime components`, {
      x: left,
      y,
      size: 11,
      font,
      color: rgb(0.3, 0.3, 0.3),
    });
    y -= 30;

    for (let block = 0; block < 2; block++) {
      page.drawText(`${p + 1}.${block + 1} Table ${p * 2 + block + 1}`, {
        x: left,
        y,
        size: 13,
        font: bold,
      });
      y -= 20;

      // header row
      let x = left;
      HEADERS.forEach((h, c) => {
        page.drawText(h, { x: x + 3, y, size: 9, font: bold });
        x += colWidths[c];
      });
      y -= 4;
      page.drawLine({
        start: { x: left, y },
        end: { x: left + colWidths.reduce((a, b) => a + b, 0), y },
        thickness: 0.8,
        color: rgb(0.2, 0.2, 0.2),
      });
      y -= rowHeight - 4;

      for (let r = 0; r < 10; r++) {
        const idx = (p * 20 + block * 10 + r) % COMPONENTS.length;
        const cells = [
          `SVC-${String(p * 20 + block * 10 + r + 1).padStart(3, '0')}`,
          COMPONENTS[idx],
          OWNERS[(idx + p) % OWNERS.length],
          STATUSES[(idx + r) % STATUSES.length],
          String(40 + ((idx * 37 + r * 13) % 960)),
          NOTES[(idx + r + p) % NOTES.length],
        ];
        x = left;
        cells.forEach((cell, c) => {
          page.drawText(cell, { x: x + 3, y, size: 9, font });
          x += colWidths[c];
        });
        y -= rowHeight;
      }
      y -= 12;
    }

    page.drawText('Figures are synthetic and exist only to exercise the converter.', {
      x: left,
      y,
      size: 9,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });

    // running header / page number — the prompt says to drop these
    page.drawText('CONFIDENTIAL — Internal Draft', {
      x: left,
      y: height - 28,
      size: 8,
      font,
      color: rgb(0.55, 0.55, 0.55),
    });
    page.drawText(`Page ${p + 1} of 4`, {
      x: width - 100,
      y: 28,
      size: 8,
      font,
      color: rgb(0.55, 0.55, 0.55),
    });
  }

  fs.writeFileSync(dest, Buffer.from(await doc.save()));
}

async function makeImageOnlyPdf(dest: string) {
  const { PDFDocument } = await import('pdf-lib');
  if (!fs.existsSync(IMAGE_SOURCE)) {
    throw new Error(`source image not found: ${IMAGE_SOURCE} (set SPIKE_PNG)`);
  }
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(fs.readFileSync(IMAGE_SOURCE));
  const width = 612;
  const height = 792;
  const margin = 24;
  const scale = Math.min((width - margin * 2) / png.width, (height - margin * 2) / png.height);
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage([width, height]);
    const w = png.width * scale;
    const h = png.height * scale;
    page.drawImage(png, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h });
    // deliberately no drawText: the page has no text layer, like a scan
  }
  fs.writeFileSync(dest, Buffer.from(await doc.save()));
}

async function main() {
  ensureDirs();
  const tablePath = path.join(SAMPLES_DIR, 'table-heavy.pdf');
  const imagePath = path.join(SAMPLES_DIR, 'image-only.pdf');
  await makeTablePdf(tablePath);
  await makeImageOnlyPdf(imagePath);
  for (const f of [tablePath, imagePath]) {
    console.log(`${f}  ${fs.statSync(f).size} bytes`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
