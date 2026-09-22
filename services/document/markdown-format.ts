import { Renderer, marked } from 'marked';
import type { Tokens as MarkedTokens } from 'marked';

/**
 * Sentinel used to hand cell boundaries from `tablecell` to `tablerow`: marked
 * concatenates the rendered cells into a single string before calling
 * `tablerow({ text })`, so the boundaries have to survive inside that string.
 * NUL never occurs in markdown source that reached us as text.
 */
const TABLE_CELL_DELIMITER = '\u0000';

/** How cells are joined on a rendered row. */
const TABLE_CELL_SEPARATOR = ' | ';

/**
 * Slack mrkdwn has no table syntax, so the header row is emphasised by bolding
 * the whole line. A header cell may already contain `*` from inline strong, and
 * wrapping such a line would produce `**A* | *B**`, which the `**x**` → `*x*`
 * post-processing (and Slack itself) mangles. Choice: bold the row only when the
 * joined line does not already start and end with `*`; otherwise the inline bold
 * that is already there carries the emphasis.
 */
function boldTableHeaderRow(line: string): string {
  if (line.length === 0) return line;
  if (line.startsWith('*') && line.endsWith('*')) return line;
  return `*${line}*`;
}

export async function convertMarkdownToSlackText(markdown: string): Promise<string> {
  const renderer = new Renderer();

  let firstHeadingFound = false;

  renderer.hr = () => '---\n';

  renderer.heading = ({ text, depth }: MarkedTokens.Heading) => {
    if (!firstHeadingFound) {
      firstHeadingFound = true;
      return '';
    }
    return depth <= 2 ? `*${text}*\n\n` : `${text}\n\n`;
  };

  renderer.link = ({ text }: MarkedTokens.Link) => text;

  renderer.html = ({ text }: MarkedTokens.HTML) =>
    text.replace(/<[^>]*>([^<]*)<\/[^>]*>/g, '$1').replace(/<[^>]*>/g, '');

  renderer.list = ({ items, ordered }: MarkedTokens.List) =>
    `${items.map((item, index) => `${ordered ? `${index + 1}.` : '•'} ${item.text}`).join('\n')}\n\n`;

  renderer.code = ({ text }: MarkedTokens.Code) => `\`\`\`${text}\`\`\`\n`;
  renderer.codespan = ({ text }: MarkedTokens.Codespan) => `\`${text}\``;
  renderer.strong = ({ text }: MarkedTokens.Strong) => `*${text}*`;
  renderer.em = ({ text }: MarkedTokens.Em) => `_${text}_`;
  renderer.text = ({ text }: MarkedTokens.Text) => text;
  renderer.paragraph = ({ text }: MarkedTokens.Paragraph) => `${text}\n\n`;

  // Table renderers are plain functions (not arrow functions) so that `this` is
  // the renderer instance marked assigns `parser` to, letting cell contents go
  // through `parseInline` and therefore through the custom inline renderers
  // above (bold, code, links).
  renderer.tablecell = function tablecell(this: Renderer, token: MarkedTokens.TableCell): string {
    const content = this.parser.parseInline(token.tokens);
    // A row is one line: never let a cell introduce newlines.
    const singleLine = content.replace(/\s*\r?\n\s*/g, ' ').trim();
    return `${singleLine}${TABLE_CELL_DELIMITER}`;
  };

  renderer.tablerow = ({ text }: MarkedTokens.TableRow) => {
    const cells = text.split(TABLE_CELL_DELIMITER);
    // The trailing delimiter of the last cell leaves an empty final element.
    cells.pop();
    // Trailing empty cells keep their `|` so the column count stays visible,
    // but the dangling space after it is dropped (no trailing whitespace).
    return `${cells.join(TABLE_CELL_SEPARATOR).replace(/[ \t]+$/, '')}\n`;
  };

  renderer.table = function table(this: Renderer, token: MarkedTokens.Table): string {
    const renderRow = (cells: MarkedTokens.TableCell[]): string =>
      this.tablerow({ text: cells.map((cell) => this.tablecell(cell)).join('') });

    // The delimiter row is not part of the token stream, so it is dropped for free.
    const headerLine = boldTableHeaderRow(renderRow(token.header).replace(/\n$/, ''));
    const bodyLines = token.rows.map((row) => renderRow(row)).join('');

    return `${headerLine}\n${bodyLines}\n`;
  };

  let slackText = await marked.parse(markdown, { renderer, gfm: true, breaks: true });

  slackText = slackText.replace(/<[^>]*>([^<]*)<\/[^>]*>/g, '$1').replace(/<[^>]*>/g, '');
  slackText = slackText.replace(/\n{3,}/g, '\n\n');
  slackText = slackText.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  return slackText.trim();
}

export function preprocessMarkdownForEmbedding(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s<>"']+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
