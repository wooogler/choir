/**
 * `.docx` → markdown, on the way to being read as a transcript.
 *
 * Word is where a transcript goes to be tidied up: somebody pastes the Zoom
 * export into a document, bolds the names, and mails that around. So a docx is
 * not a third transcript format — it is one of the others wearing a zip, and the
 * only job here is to get the words back out in reading order so detection can
 * run again on them.
 *
 * mammoth for the unzip and the style mapping, then the web import's own
 * `htmlToMarkdown`: it already knows how to turn HTML into the markdown flavour
 * this repository commits, and a second converter would mean two answers to
 * "what does a nested list look like".
 */

import mammoth from 'mammoth';
import { htmlToMarkdown } from '../web/html-to-markdown';

/**
 * A base for `htmlToMarkdown`, which resolves relative URLs against it. A docx
 * has no address, and nothing in the result should look like one — anything
 * still pointing at this after the image strip below is a bug, visibly.
 */
const DOCX_BASE_URL = 'file:///doc.docx';

/** `![alt](data:image/png;base64,…)` — every image mammoth inlined. */
const DATA_URI_IMAGE = /!\[[^\]]*\]\(\s*data:[^)]*\)/g;

export async function docxToMarkdown(bytes: Buffer): Promise<string> {
  const { value: html } = await mammoth.convertToHtml({ buffer: bytes });
  const { markdown } = htmlToMarkdown(html ?? '', DOCX_BASE_URL);

  // The images go rather than being carried as assets: mammoth inlines every
  // one as base64, a transcript's images are screenshots of nothing, and a
  // meeting note is committed as text. The prose keeps its place either way.
  return markdown
    .replace(DATA_URI_IMAGE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
