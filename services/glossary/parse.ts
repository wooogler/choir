/**
 * Reading a `GLOSSARY.md` into entries.
 *
 * The glossary is a document people write by hand, so the parser is lenient on
 * purpose: header names are ignored (a team may call the columns anything, in
 * any language), only the first three columns of a table matter, and a file may
 * hold several tables under several headings. Anything it cannot read it skips
 * rather than throwing — a typo in a glossary must never break a conversion.
 *
 * mdast rather than a line regex because the real files have escaped pipes,
 * inline code, links and ragged spacing in their cells, and remark already
 * knows all of that. See docs/meeting-notes-and-glossary.md, 용어집 §3.
 */

import type { Heading, Table, TableCell, TableRow } from 'mdast';
import { toString as nodeToText } from 'mdast-util-to-string';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

export interface GlossaryEntry {
  /** The canonical spelling; the one the model is told to write. */
  term: string;
  /** Misheard spellings, abbreviations and other names for the same thing. */
  aliases: string[];
  description: string;
  /** Nearest heading above the table the row came from, when there is one. */
  section?: string;
  /** Repository path of the glossary this row came from. */
  file: string;
}

/** The two supported glossary languages; the template and the prompt use them. */
export type GlossaryLanguage = 'ko' | 'en';

/**
 * Alias separators. The ASCII pair is what people type; the ideographic comma
 * and the fullwidth semicolon are what a Korean or Japanese IME produces for
 * the same keystroke, and a list split on one but not the other silently loses
 * every alias after the first.
 */
const ALIAS_SEPARATOR = /[,;、，；]/;

/** A stray separator row (`---`, `:--:`) that a hand-edited table can carry. */
const SEPARATOR_CELL = /^:?-{2,}:?$/;

export function parseGlossaryMarkdown(markdown: string, file: string): GlossaryEntry[] {
  if (!markdown.trim()) return [];

  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const entries: GlossaryEntry[] = [];
  let section: string | undefined;

  // Preorder visit is document order, so the heading seen last is the nearest
  // one above the table being read — including for tables inside a blockquote
  // or a list, which a scan of the root's children alone would miss.
  visit(tree, (node) => {
    if (node.type === 'heading') {
      const text = nodeToText(node as Heading).trim();
      section = text || undefined;
      return;
    }
    if (node.type !== 'table') return;
    entries.push(...rowsOf(node as Table, file, section));
  });

  return entries;
}

function rowsOf(table: Table, file: string, section?: string): GlossaryEntry[] {
  // GFM gives the header row the final say over the column count, and a table
  // narrower than term | aliases | description is some other table entirely.
  const columns = table.align?.length ?? table.children[0]?.children.length ?? 0;
  if (columns < 3) return [];

  const entries: GlossaryEntry[] = [];
  // Row 0 is the header (mdast drops the `---` line), so body rows start at 1.
  for (const row of table.children.slice(1)) {
    const entry = rowToEntry(row, file, section);
    if (entry) entries.push(entry);
  }
  return entries;
}

function rowToEntry(row: TableRow, file: string, section?: string): GlossaryEntry | undefined {
  const cells = row.children.map((cell) => cellText(cell));
  const term = cells[0]?.trim() ?? '';
  if (!term || SEPARATOR_CELL.test(term)) return undefined;

  return {
    term,
    aliases: splitAliases(cells[1] ?? ''),
    description: (cells[2] ?? '').trim(),
    ...(section ? { section } : {}),
    file,
  };
}

function cellText(cell: TableCell): string {
  return nodeToText(cell).replace(/\s+/g, ' ').trim();
}

export function splitAliases(value: string): string[] {
  return value
    .split(ALIAS_SEPARATOR)
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0 && !SEPARATOR_CELL.test(alias));
}

const TEMPLATE_HEADERS: Record<GlossaryLanguage, { title: string; columns: [string, string, string] }> = {
  ko: { title: '용어집', columns: ['용어', '다른 표기', '설명'] },
  en: { title: 'Glossary', columns: ['Term', 'Also known as', 'Description'] },
};

/** The header rows of an empty glossary table, without a title above them. */
export function glossaryTableHeader(language: GlossaryLanguage): string {
  const { columns } = TEMPLATE_HEADERS[language];
  return `| ${columns.join(' | ')} |\n| --- | --- | --- |`;
}

/** A whole new `GLOSSARY.md`: a title and one empty table, ready to be filled. */
export function GLOSSARY_TEMPLATE(language: GlossaryLanguage): string {
  return `# ${TEMPLATE_HEADERS[language].title}\n\n${glossaryTableHeader(language)}\n`;
}
