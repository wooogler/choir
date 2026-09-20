/**
 * Adding rows to a glossary file without disturbing anything else in it.
 *
 * The file is someone's document: it may have a preface, several tables under
 * several headings, and notes after the last one. So this appends to the last
 * table that looks like a glossary and leaves every other byte alone — the diff
 * a manager reviews should be the rows they asked for, nothing more.
 *
 * Adding a term that is already there is a no-op rather than an error, because
 * the callers (the meeting-note loop, the extraction preview) will propose the
 * same term twice sooner or later, and a glossary with CHOIR in it three times
 * is worse than one that quietly refused.
 */

import type { Table } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { detectLanguage } from 'services/common/language';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { type GlossaryLanguage, glossaryTableHeader, parseGlossaryMarkdown } from './parse';

export interface GlossaryRowInput {
  term: string;
  aliases: string[];
  description: string;
}

export interface AppendGlossaryRowsResult {
  markdown: string;
  added: number;
  /** Terms already in the file (or repeated in `rows`), in the order given. */
  skipped: string[];
}

export interface AppendGlossaryRowsOptions {
  /** Language of a table this has to create; guessed from the text otherwise. */
  language?: GlossaryLanguage;
}

export function appendGlossaryRows(
  markdown: string,
  rows: GlossaryRowInput[],
  options: AppendGlossaryRowsOptions = {},
): AppendGlossaryRowsResult {
  const existing = new Set(parseGlossaryMarkdown(markdown, '').map((entry) => entry.term.toLowerCase()));
  const skipped: string[] = [];
  const lines: string[] = [];

  for (const row of rows) {
    const term = row.term.trim();
    if (!term) continue;
    if (existing.has(term.toLowerCase())) {
      skipped.push(row.term);
      continue;
    }
    // Added to `existing` immediately so a duplicate inside `rows` is skipped
    // by the same rule as one already in the file.
    existing.add(term.toLowerCase());
    lines.push(rowLine(term, row));
  }

  if (lines.length === 0) return { markdown, added: 0, skipped };

  const target = lastGlossaryTable(markdown);
  if (target !== undefined) {
    // The end offset sits at the end of the table's last row, before its
    // newline, so the rows go in there and everything after is untouched.
    return {
      markdown: `${markdown.slice(0, target)}\n${lines.join('\n')}${markdown.slice(target)}`,
      added: lines.length,
      skipped,
    };
  }

  const language = options.language ?? guessLanguage(markdown, rows);
  const header = glossaryTableHeader(language);
  const body = markdown.replace(/\s+$/, '');
  // A file with content already has a title; only an empty one gets a new one.
  const prefix = body ? `${body}\n\n${header}` : `# ${language === 'ko' ? '용어집' : 'Glossary'}\n\n${header}`;

  return { markdown: `${prefix}\n${lines.join('\n')}\n`, added: lines.length, skipped };
}

function rowLine(term: string, row: GlossaryRowInput): string {
  const aliases = row.aliases
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0)
    .join(', ');
  return `| ${escapeCell(term)} | ${escapeCell(aliases)} | ${escapeCell(row.description)} |`;
}

/**
 * A table cell is one line, and a bare `|` in it would end the cell early and
 * shift every column after it. The backslash goes first so an escape that was
 * already in the text survives as text.
 */
export function escapeCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/** End offset of the last table wide enough to be a glossary, or undefined. */
function lastGlossaryTable(markdown: string): number | undefined {
  if (!markdown.trim()) return undefined;

  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  let end: number | undefined;

  visit(tree, 'table', (node: Table) => {
    const columns = node.align?.length ?? node.children[0]?.children.length ?? 0;
    const offset = node.position?.end?.offset;
    if (columns >= 3 && typeof offset === 'number') end = offset;
  });

  return end;
}

/**
 * Which language a table this has to create is headed in. The file the table
 * joins decides when it has any text — a Korean term added to an English page
 * should not flip that page's headers — and the rows decide for a new file.
 */
function guessLanguage(markdown: string, rows: GlossaryRowInput[]): GlossaryLanguage {
  const sample =
    markdown.trim() || rows.map((row) => `${row.term} ${row.aliases.join(' ')} ${row.description}`).join(' ');
  return detectLanguage(sample) === 'ko' ? 'ko' : 'en';
}
