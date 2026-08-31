import { Renderer, marked } from 'marked';
import type { Tokens as MarkedTokens } from 'marked';

/**
 * Renders markdown to HTML shaped for Google Drive's HTML → Google Docs import.
 *
 * Drive's importer keeps semantic tags (h1-h6 become Heading 1-6 named styles and
 * therefore the document outline, tables become real Docs tables) but drops CSS
 * classes and stylesheets, so anything that must survive is expressed as inline
 * styles on the element itself.
 *
 * Image `src` must be an absolute, publicly fetchable URL: Drive downloads it
 * server-side during conversion. Repo-relative paths silently produce a broken
 * image, so callers rewrite them first (see resolveImageUrl).
 */

export interface DocsHtmlOptions {
  title: string;
  /** Rewrites a markdown image src to an absolute public URL, or null to drop it. */
  resolveImageUrl?: (src: string) => string | null;
  /** Prepended banner marking the doc as a generated replica. */
  banner?: string;
}

const CODE_FONT = "'Roboto Mono', 'Courier New', monospace";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarkdownToDocsHtml(markdown: string, options: DocsHtmlOptions): string {
  const renderer = new Renderer();

  // Fenced code MUST use <pre>. Measured against Drive's importer: a styled <p>
  // with `white-space: pre-wrap` has its newlines collapsed (the whole block
  // arrives as one line), and <br>+&nbsp; keeps the breaks but turns each line
  // into its own paragraph and drops the indentation. Only <pre> survives with
  // line breaks and leading whitespace intact.
  renderer.code = ({ text, lang }: MarkedTokens.Code) => {
    const label = lang ? `<div style="font-family:${CODE_FONT};font-size:9pt;color:#666;">${escapeHtml(lang)}</div>` : '';
    return `${label}<pre style="font-family:${CODE_FONT};font-size:10pt;background-color:#f5f5f5;padding:8px;">${escapeHtml(
      text,
    )}</pre>`;
  };

  renderer.codespan = ({ text }: MarkedTokens.Codespan) =>
    `<span style="font-family:${CODE_FONT};background-color:#f5f5f5;">${escapeHtml(text)}</span>`;

  // Drop images whose src can't be resolved to a public URL rather than emitting
  // a tag Drive will turn into a broken-image placeholder.
  renderer.image = ({ href, text, title }: MarkedTokens.Image) => {
    const resolved = options.resolveImageUrl ? options.resolveImageUrl(href) : href;
    if (!resolved) {
      return '';
    }
    const alt = escapeHtml(text || '');
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(resolved)}" alt="${alt}"${titleAttr} />`;
  };

  const body = marked.parse(markdown, { renderer, gfm: true, async: false }) as string;

  const banner = options.banner
    ? `<p style="background-color:#fff3cd;padding:8px;font-size:10pt;"><i>${escapeHtml(options.banner)}</i></p>`
    : '';

  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8" />',
    `<title>${escapeHtml(options.title)}</title>`,
    '</head><body>',
    banner,
    body,
    '</body></html>',
  ].join('\n');
}
