import { PDFDocument, StandardFonts } from 'pdf-lib';
import { slicePdf } from 'services/import/sources/pdf/chunk';

async function buildPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= pageCount; page += 1) {
    doc.addPage([595, 842]).drawText(`Page ${page}`, { x: 50, y: 780, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

async function pageCountOf(bytes: Buffer): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

describe('slicePdf', () => {
  it('keeps only the requested pages, 1-based and inclusive', async () => {
    const bytes = await buildPdf(10);
    expect(await pageCountOf(await slicePdf(bytes, 3, 5))).toBe(3);
    expect(await pageCountOf(await slicePdf(bytes, 1, 1))).toBe(1);
    expect(await pageCountOf(await slicePdf(bytes, 10, 10))).toBe(1);
  });

  it('produces a standalone PDF', async () => {
    const slice = await slicePdf(await buildPdf(6), 2, 4);
    expect(slice.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('hands back the original bytes when the range is the whole document', async () => {
    const bytes = await buildPdf(3);
    expect(await slicePdf(bytes, 1, 3)).toBe(bytes);
  });

  it('rejects a range that is not a range', async () => {
    const bytes = await buildPdf(3);
    await expect(slicePdf(bytes, 0, 2)).rejects.toThrow(/Invalid PDF page range/);
    await expect(slicePdf(bytes, 3, 1)).rejects.toThrow(/Invalid PDF page range/);
    await expect(slicePdf(bytes, 1.5, 2)).rejects.toThrow(/Invalid PDF page range/);
  });

  it('rejects a range past the end of the document', async () => {
    await expect(slicePdf(await buildPdf(3), 2, 9)).rejects.toThrow(/exceeds/);
  });
});
