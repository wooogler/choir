import 'dotenv/config';
import fs from 'node:fs';
import { convertUrl } from 'services/import/sources/web';
import { convertPdf, inspectPdf, planPdfImport, estimatePdfImport, loadPdfImportConfig } from 'services/import/sources/pdf';
import { toPdfLlmClient } from 'services/import/sources/pdf/llm-convert';
import { slicePdf } from 'services/import/sources/pdf/chunk';
import { getOpenAIClient } from 'services/llm/openai-client-factory';
import { prepareCommit } from 'services/import/commit-guard';
import { buildSourceNote, prependSourceNote } from 'services/import/source-note';

(async () => {
  const t0 = Date.now();
  const web = await convertUrl('https://github.com/mozilla/readability', { onProgress: (e) => console.log('web>', e.step, e.label) });
  console.log('WEB title:', web.title, '| md chars:', web.markdown.length, '| assets:', web.assets.length, '| rejected:', web.rejectedAssets.length, '| warnings:', JSON.stringify(web.warnings), '| ms:', Date.now() - t0);
  console.log(web.markdown.split('\n').filter((l) => l.startsWith('#')).slice(0, 8).join('\n'));

  const full = fs.readFileSync('/usr/share/doc/shared-mime-info/shared-mime-info-spec.pdf');
  const bytes = await slicePdf(full, 1, 3);
  const config = loadPdfImportConfig();
  const client = toPdfLlmClient(getOpenAIClient(process.env.OPENAI_API_KEY as string));
  const model = 'gpt-5.4-mini';
  const inspection = await inspectPdf(bytes, config);
  const plan = planPdfImport(inspection, config);
  const est = await estimatePdfImport({ workspaceId: 'e2e', bytes, filename: 'spec.pdf', inspection, plan, config, client, model });
  console.log('PDF estimate:', JSON.stringify(est));
  const t1 = Date.now();
  const pdf = await convertPdf({ workspaceId: 'e2e', bytes, filename: 'spec.pdf', config, client, model, onProgress: (e) => console.log('pdf>', e.step, e.label, e.current ?? '', e.total ?? '') });
  console.log('PDF title:', pdf.title, '| md chars:', pdf.markdown.length, '| warnings:', JSON.stringify(pdf.warnings), '| source:', JSON.stringify(pdf.source), '| ms:', Date.now() - t1);
  console.log(pdf.markdown.split('\n').filter((l) => l.startsWith('#')).slice(0, 8).join('\n'));

  const prepared = prepareCommit({ markdown: pdf.markdown, document: pdf });
  const note = buildSourceNote(pdf.source, { language: 'ko' as never });
  console.log('NOTE:', note);
  console.log(prependSourceNote(prepared.markdown, note).split('\n').slice(0, 4).join('\n'));
  fs.writeFileSync('/tmp/claude-1000/-home-sangwonlee-choir/bc75310f-e495-4d09-9f72-e8d96901f237/scratchpad/e2e-web.md', web.markdown);
  fs.writeFileSync('/tmp/claude-1000/-home-sangwonlee-choir/bc75310f-e495-4d09-9f72-e8d96901f237/scratchpad/e2e-pdf.md', pdf.markdown);
})().catch((e) => { console.error('E2E FAILED', e); process.exit(1); });
