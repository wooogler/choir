import { Renderer, marked } from 'marked';
import type { Tokens as MarkedTokens } from 'marked';

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
    items.map((item, index) => `${ordered ? `${index + 1}.` : '•'} ${item.text}`).join('\n') + '\n\n';

  renderer.code = ({ text }: MarkedTokens.Code) => `\`\`\`${text}\`\`\`\n`;
  renderer.codespan = ({ text }: MarkedTokens.Codespan) => `\`${text}\``;
  renderer.strong = ({ text }: MarkedTokens.Strong) => `*${text}*`;
  renderer.em = ({ text }: MarkedTokens.Em) => `_${text}_`;
  renderer.text = ({ text }: MarkedTokens.Text) => text;
  renderer.paragraph = ({ text }: MarkedTokens.Paragraph) => `${text}\n\n`;

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
