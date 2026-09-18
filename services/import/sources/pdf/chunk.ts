/**
 * Cuts a page range out of a PDF so a chunk can be sent on its own.
 *
 * pdfjs can read a PDF but cannot write one, so this is pdf-lib's job. The
 * output has to be a valid standalone PDF because that is what the Responses API
 * `input_file` part receives — we cannot ask it for "pages 21–40 of this file".
 */

import { PDFDocument } from 'pdf-lib';

/**
 * Returns a PDF containing pages `from`..`to` (1-based, inclusive) of `bytes`.
 * Returns the original bytes untouched when the range is the whole document.
 */
export async function slicePdf(bytes: Buffer, from: number, to: number): Promise<Buffer> {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    throw new Error(`Invalid PDF page range: ${from}-${to}`);
  }

  // `ignoreEncryption: false` keeps an encrypted PDF a hard failure here too;
  // the gate already refuses them, and silently producing a broken slice would
  // only turn that refusal into a confusing conversion error later.
  const source = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const pageCount = source.getPageCount();
  if (to > pageCount) {
    throw new Error(`PDF page range ${from}-${to} exceeds the document's ${pageCount} pages`);
  }
  if (from === 1 && to === pageCount) return bytes;

  const indices: number[] = [];
  for (let page = from; page <= to; page += 1) indices.push(page - 1);

  const slice = await PDFDocument.create();
  const copied = await slice.copyPages(source, indices);
  for (const page of copied) slice.addPage(page);

  // Object streams save bytes but not every reader (or the API's extractor)
  // handles them; a chunk is small enough that the tradeoff is not worth it.
  return Buffer.from(await slice.save({ useObjectStreams: false }));
}
