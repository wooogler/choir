import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdownToDocsHtml } from './markdown-to-docs-html';

/**
 * Renders a markdown file to Docs-import HTML and writes it next to the source.
 *
 *   pnpm ts-node -r tsconfig-paths/register scripts/spike-gdocs/render.ts <file.md> [out.html]
 */
const input = process.argv[2] || path.join(__dirname, 'fixture.md');
const output = process.argv[3] || `${input.replace(/\.md$/, '')}.html`;

const markdown = fs.readFileSync(input, 'utf-8');
const html = renderMarkdownToDocsHtml(markdown, {
  title: path.basename(input, '.md'),
  banner: '이 문서는 GitHub에서 자동 생성된 복제본입니다. 여기서 편집한 내용은 반영되지 않습니다.',
});

fs.writeFileSync(output, html, 'utf-8');
console.log(`Wrote ${output} (${html.length} bytes)`);
