/**
 * P0 spike: verifies the assumptions docs/google-drive-sync.md is built on that
 * the Drive MCP connector cannot answer (it authenticates with broad scopes and
 * its update tool only changes metadata).
 *
 * With ONLY the `drive.file` scope — the non-sensitive one that avoids
 * restricted-scope verification and the annual CASA assessment — it proves (or
 * disproves) that an app can:
 *
 *   1. create a folder,
 *   2. create a Google Doc by importing markdown (--html for the HTML path),
 *   3. REPLACE that doc's content in place and keep the same fileId/URL,
 *   4. observe `version` on the update response and again on files.get,
 *   5. round-trip identical content to an identical markdown export,
 *   6. tell a content change from a metadata-only change,
 *   7. set a reader permission,
 *   8. list what it created — and nothing else.
 *
 * Check 3 is load-bearing for the stable Doc URL. Checks 4-6 are load-bearing for
 * drift detection: the publisher records a version it observed atomically with the
 * content it baselined, and the poller decides "human edited this" by comparing a
 * fresh export against that baseline. If exports are not deterministic, the
 * baseline 3-way merge has no ground truth.
 *
 * Setup:
 *   # GCP console → enable the Drive API → create an OAuth 2.0 Client ID of type
 *   # "Desktop app", download the JSON, and point GOOGLE_OAUTH_CLIENT at it.
 *   export GOOGLE_OAUTH_CLIENT=/path/to/client_secret.json
 *
 * Run:
 *   pnpm spike:gdocs
 *   node dist-spike/drive-spike.js [--shared-drive <driveId>] [--keep] [--html]
 *
 * (The repo's ts-node cannot run this directly — see the note at the bottom of
 * scripts/spike-gdocs/README.md.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { drive as driveClient } from '@googleapis/drive';
import { renderMarkdownToDocsHtml } from './markdown-to-docs-html';
import { SPIKE_SOURCE_DIR, authorize, compareText, exportMarkdown, normalizeDataUrls } from './spike-common';

interface Args {
  sharedDriveId?: string;
  keep: boolean;
  useHtml: boolean;
}

function parseArgs(argv: string[]): Args {
  const sharedDriveIndex = argv.indexOf('--shared-drive');
  return {
    sharedDriveId: sharedDriveIndex >= 0 ? argv[sharedDriveIndex + 1] : undefined,
    keep: argv.includes('--keep'),
    useHtml: argv.includes('--html'),
  };
}

const BANNER = '이 문서는 GitHub에서 자동 생성된 복제본입니다. 여기서 편집한 내용은 반영되지 않습니다.';

/**
 * Builds the upload body for a doc. Markdown is the default because it measured
 * better than HTML on lists, blockquotes, rules and heading cleanliness (see
 * README); --html switches to the rendered-HTML path, which only wins on code
 * blocks.
 */
function uploadBody(markdown: string, title: string, useHtml: boolean): { mimeType: string; body: string } {
  if (useHtml) {
    return { mimeType: 'text/html', body: renderMarkdownToDocsHtml(markdown, { title, banner: BANNER }) };
  }
  return { mimeType: 'text/markdown', body: `*${BANNER}*\n\n${markdown}` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const auth = await authorize();
  const drive = driveClient({ version: 'v3', auth });

  // The real fixture, not a toy string: nested lists, a table, a fenced code
  // block and a remote image are exactly the constructs whose export stability
  // the design depends on.
  const fixture = fs.readFileSync(path.join(SPIKE_SOURCE_DIR, 'fixture.md'), 'utf-8');
  const editedFixture = `${fixture}\n\n## 8. 두 번째 버전\n\n내용이 교체되었습니다.\n`;

  // Shared-drive calls need these flags on every request, so build them once.
  const sharedDriveOpts = args.sharedDriveId ? { supportsAllDrives: true } : {};
  const results: Array<{ step: string; ok: boolean; detail: string }> = [];
  const record = (step: string, ok: boolean, detail: string) => {
    results.push({ step, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`);
  };

  let folderId: string | undefined;
  let docId: string | undefined;

  // 1. Folder creation — replicas live in a CHOIR-owned folder.
  try {
    const folder = await drive.files.create({
      requestBody: {
        name: `choir-spike-${Date.now()}`,
        mimeType: 'application/vnd.google-apps.folder',
        parents: args.sharedDriveId ? [args.sharedDriveId] : undefined,
      },
      fields: 'id, name, driveId',
      ...sharedDriveOpts,
    });
    folderId = folder.data.id ?? undefined;
    record('1. create folder', true, `id=${folderId} driveId=${folder.data.driveId ?? '(My Drive)'}`);
  } catch (error) {
    record('1. create folder', false, (error as Error).message);
  }

  // 2. Create the Doc by importing markdown (mimeType asks Drive to convert).
  const importLabel = `2. import ${args.useHtml ? 'HTML' : 'markdown'} as Doc`;
  try {
    const created = await drive.files.create({
      requestBody: {
        name: 'CHOIR replica spike',
        mimeType: 'application/vnd.google-apps.document',
        parents: folderId ? [folderId] : undefined,
      },
      media: uploadBody(fixture, 'v1', args.useHtml),
      fields: 'id, webViewLink, mimeType, version',
      ...sharedDriveOpts,
    });
    docId = created.data.id ?? undefined;
    record(
      importLabel,
      created.data.mimeType === 'application/vnd.google-apps.document',
      `id=${docId} version=${created.data.version} url=${created.data.webViewLink}`,
    );
  } catch (error) {
    record(importLabel, false, (error as Error).message);
  }

  if (!docId) {
    console.log('\nNo document to test against — aborting the remaining checks.');
    process.exitCode = 1;
    return;
  }

  // 3. Repeated export of an unchanged doc must be byte-identical, or the poller
  //    would flag drift on every tick with nobody having touched the document.
  let baselineA = '';
  try {
    baselineA = await exportMarkdown(drive, docId);
    const baselineB = await exportMarkdown(drive, docId);
    const raw = compareText(baselineA, baselineB);
    if (raw.identical) {
      record('3. export is repeatable', true, raw.summary);
    } else {
      // Distinguish "the serializer is unstable" from "only base64 image payloads
      // wobble", which the design could normalize away.
      const normalized = compareText(normalizeDataUrls(baselineA), normalizeDataUrls(baselineB));
      record(
        '3. export is repeatable',
        false,
        normalized.identical
          ? `differs ONLY inside base64 image payloads — normalizable. ${raw.summary}`
          : raw.summary,
      );
    }
  } catch (error) {
    record('3. export is repeatable', false, (error as Error).message);
  }

  // 4. THE load-bearing check: replace content in place, same fileId and URL.
  //    Also capture `version` from the update response and again from files.get —
  //    the publisher's fence needs both to be observable and to agree when nobody
  //    else is editing.
  let versionAfterUpdate: string | undefined;
  try {
    const before = docId;
    const updated = await drive.files.update({
      fileId: docId,
      media: uploadBody(editedFixture, 'v2', args.useHtml),
      fields: 'id, webViewLink, modifiedTime, version',
      ...sharedDriveOpts,
    });
    const stable = updated.data.id === before;
    versionAfterUpdate = updated.data.version ?? undefined;
    record(
      '4. replace content in place',
      stable,
      stable
        ? `fileId unchanged (${before}), version=${versionAfterUpdate}, url=${updated.data.webViewLink}`
        : `fileId CHANGED: ${before} → ${updated.data.id}`,
    );
  } catch (error) {
    record('4. replace content in place', false, (error as Error).message);
  }

  // 5. The version fence: files.update's response version must be observable and
  //    must match a files.get taken right after. If update does not return a
  //    version, the publisher cannot fence and must fall back to get-before/after.
  try {
    const meta = await drive.files.get({ fileId: docId, fields: 'version, modifiedTime', ...sharedDriveOpts });
    const versionFromGet = meta.data.version ?? undefined;
    const observable = Boolean(versionAfterUpdate);
    const agree = observable && versionAfterUpdate === versionFromGet;
    record(
      '5. version fence (update vs get)',
      agree,
      observable
        ? `update=${versionAfterUpdate} get=${versionFromGet}${agree ? ' (agree)' : ' — DISAGREE: fence must use get-before/after'}`
        : 'files.update did NOT return `version` — fence must use get-before/after',
    );
  } catch (error) {
    record('5. version fence (update vs get)', false, (error as Error).message);
  }

  // 6. Round-trip determinism, the real drift-detection assumption: pushing the
  //    SAME content again must export to the SAME markdown. If it does not, every
  //    republish would look like a human edit.
  try {
    const baselineBeforeNoop = await exportMarkdown(drive, docId);
    await drive.files.update({
      fileId: docId,
      media: uploadBody(editedFixture, 'v2-again', args.useHtml),
      fields: 'id, version',
      ...sharedDriveOpts,
    });
    const baselineAfterNoop = await exportMarkdown(drive, docId);
    const raw = compareText(baselineBeforeNoop, baselineAfterNoop);
    if (raw.identical) {
      record('6. identical re-push → identical export', true, raw.summary);
    } else {
      const normalized = compareText(normalizeDataUrls(baselineBeforeNoop), normalizeDataUrls(baselineAfterNoop));
      record(
        '6. identical re-push → identical export',
        false,
        normalized.identical
          ? `differs ONLY inside base64 image payloads — normalizable. ${raw.summary}`
          : raw.summary,
      );
    }
  } catch (error) {
    record('6. identical re-push → identical export', false, (error as Error).message);
  }

  // 7. A metadata-only change (rename) tells us how noisy `version` is as a
  //    trigger. A bump here is expected and harmless — it is why export-vs-baseline
  //    is the truth test rather than version alone — but measure it, don't assume.
  try {
    const beforeRename = await drive.files.get({ fileId: docId, fields: 'version', ...sharedDriveOpts });
    await drive.files.update({
      fileId: docId,
      requestBody: { name: 'CHOIR replica spike (renamed)' },
      fields: 'id',
      ...sharedDriveOpts,
    });
    const afterRename = await drive.files.get({ fileId: docId, fields: 'version', ...sharedDriveOpts });
    const bumped = beforeRename.data.version !== afterRename.data.version;
    record(
      '7. metadata-only change bumps version?',
      true,
      bumped
        ? `YES (${beforeRename.data.version} → ${afterRename.data.version}) — version is a trigger only; export-vs-baseline is the truth test`
        : `NO (stayed ${afterRename.data.version}) — version tracks content only`,
    );
  } catch (error) {
    record('7. metadata-only change bumps version?', false, (error as Error).message);
  }

  // 8. Read-only sharing, so viewers can't edit a doc whose edits would be lost.
  try {
    await drive.permissions.create({
      fileId: docId,
      requestBody: { type: 'anyone', role: 'reader' },
      ...sharedDriveOpts,
    });
    record('8. set reader permission', true, 'type=anyone role=reader');
  } catch (error) {
    record('8. set reader permission', false, (error as Error).message);
  }

  // 9. Confirm drive.file really does keep access to what we created — and
  //    nothing else. A files.list restricted to our folder should return the doc.
  if (folderId) {
    try {
      const listed = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)',
        ...(args.sharedDriveId
          ? { supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'drive', driveId: args.sharedDriveId }
          : {}),
      });
      const found = (listed.data.files || []).some((f) => f.id === docId);
      record('9. list app-created files', found, `${listed.data.files?.length ?? 0} file(s) visible in folder`);
    } catch (error) {
      record('9. list app-created files', false, (error as Error).message);
    }
  }

  if (baselineA) {
    const dumpPath = path.join(__dirname, 'export-sample.md');
    try {
      fs.writeFileSync(dumpPath, baselineA, 'utf-8');
      console.log(`\nFirst export written to ${dumpPath} for eyeballing conversion fidelity.`);
    } catch {
      // Non-essential.
    }
  }

  if (!args.keep) {
    for (const id of [docId, folderId].filter(Boolean) as string[]) {
      await drive.files.delete({ fileId: id, ...sharedDriveOpts }).catch(() => undefined);
    }
    console.log('Cleaned up spike files (pass --keep to inspect them by hand).');
  } else {
    console.log(`\nKept: https://docs.google.com/document/d/${docId}/edit`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
