"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderMarkdownToDocsHtml = renderMarkdownToDocsHtml;
const marked_1 = require("marked");
const CODE_FONT = "'Roboto Mono', 'Courier New', monospace";
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function renderMarkdownToDocsHtml(markdown, options) {
    const renderer = new marked_1.Renderer();
    // Fenced code MUST use <pre>. Measured against Drive's importer: a styled <p>
    // with `white-space: pre-wrap` has its newlines collapsed (the whole block
    // arrives as one line), and <br>+&nbsp; keeps the breaks but turns each line
    // into its own paragraph and drops the indentation. Only <pre> survives with
    // line breaks and leading whitespace intact.
    renderer.code = ({ text, lang }) => {
        const label = lang ? `<div style="font-family:${CODE_FONT};font-size:9pt;color:#666;">${escapeHtml(lang)}</div>` : '';
        return `${label}<pre style="font-family:${CODE_FONT};font-size:10pt;background-color:#f5f5f5;padding:8px;">${escapeHtml(text)}</pre>`;
    };
    renderer.codespan = ({ text }) => `<span style="font-family:${CODE_FONT};background-color:#f5f5f5;">${escapeHtml(text)}</span>`;
    // Drop images whose src can't be resolved to a public URL rather than emitting
    // a tag Drive will turn into a broken-image placeholder.
    renderer.image = ({ href, text, title }) => {
        const resolved = options.resolveImageUrl ? options.resolveImageUrl(href) : href;
        if (!resolved) {
            return '';
        }
        const alt = escapeHtml(text || '');
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<img src="${escapeHtml(resolved)}" alt="${alt}"${titleAttr} />`;
    };
    const body = marked_1.marked.parse(markdown, { renderer, gfm: true, async: false });
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
