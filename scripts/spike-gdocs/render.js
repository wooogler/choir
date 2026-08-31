"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const markdown_to_docs_html_1 = require("./markdown-to-docs-html");
/**
 * Renders a markdown file to Docs-import HTML and writes it next to the source.
 *
 *   pnpm ts-node -r tsconfig-paths/register scripts/spike-gdocs/render.ts <file.md> [out.html]
 */
const input = process.argv[2] || node_path_1.default.join(__dirname, 'fixture.md');
const output = process.argv[3] || `${input.replace(/\.md$/, '')}.html`;
const markdown = node_fs_1.default.readFileSync(input, 'utf-8');
const html = (0, markdown_to_docs_html_1.renderMarkdownToDocsHtml)(markdown, {
    title: node_path_1.default.basename(input, '.md'),
    banner: '이 문서는 GitHub에서 자동 생성된 복제본입니다. 여기서 편집한 내용은 반영되지 않습니다.',
});
node_fs_1.default.writeFileSync(output, html, 'utf-8');
console.log(`Wrote ${output} (${html.length} bytes)`);
