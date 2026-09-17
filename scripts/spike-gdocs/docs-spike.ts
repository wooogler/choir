/**
 * P0-C spike: can CHOIR edit a richly formatted Google Doc *in place*, paragraph
 * by paragraph, instead of replacing its whole content?
 *
 * docs/gdocs-format-preserving-sync.md recommends replacing the one destructive
 * primitive (`files.update` with `media: text/markdown`, which Google documents
 * as replacing the full contents) with `documents.batchUpdate` requests confined
 * to the paragraphs whose repository markdown actually changed. Every assumption
 * that recommendation rests on and that the earlier spikes did not measure is
 * checked here:
 *
 *   0. `files.copy` works on a Picker-granted file under `drive.file`
 *      (the Phase A backup mechanism).
 *   1. `documents.get` reaches a document this app did not create, from a client
 *      holding only the refresh token. THE GATE — if this fails, the whole
 *      in-place design is impossible without the sensitive `documents` scope.
 *   2. `documents.batchUpdate` is authorized on that document (no-op batch).
 *   3. `documents.get` honours a `fields` mask (a cheap tab pre-check at import).
 *   4. The markdown export of a richly formatted document is byte-deterministic.
 *      Everything drift detection does rests on this, and it has only ever been
 *      measured on documents CHOIR itself created from markdown.
 *   5. A content-changing `batchUpdate` bumps Drive's `version` — the poller's
 *      only change trigger.
 *   6. A stale `writeControl.requiredRevisionId` is refused (the write fence).
 *   7. Hollowing a paragraph and refilling it keeps its ParagraphStyle and the
 *      surrounding run's TextStyle. This is what "untouched formatting survives"
 *      means for a paragraph CHOIR does rewrite.
 *   8. A new paragraph can be inserted at `endIndex - 1` of an existing one, and
 *      NOT at the body's end index. (Four of the five candidate designs got this
 *      wrong; appending a section is the most common CHOIR-side update.)
 *   9. Inventory: how much of this document is structurally out of reach —
 *      tables, inline/positioned objects, soft line breaks, multiple tabs — and
 *      whether each export line corresponds to exactly one Doc paragraph.
 *
 * SAFETY: every write happens on a `files.copy` of the document you name, never
 * on the document itself. The copy is deleted at the end unless you pass --keep.
 * Only --no-copy writes to the original, and it exists for the case where you
 * already made a throwaway by hand.
 *
 * Setup: the same GOOGLE_OAUTH_CLIENT desktop-app JSON the other spikes use, and
 * a doc this app can reach — either one it created, or one you granted through
 * picker-spike. Enable the **Google Docs API** on the same GCP project first;
 * check 1 fails with a 403 "API has not been used" until you do.
 *
 * Run:
 *   pnpm spike:gdocs
 *   GOOGLE_OAUTH_CLIENT=/path/to/client_secret.json \
 *     node dist-spike/docs-spike.js --file-id <documentId> [--keep] [--no-copy]
 */

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { drive as driveClient, auth as googleAuth } from '@googleapis/drive';
import {
  SPIKE_SOURCE_DIR,
  authorize,
  compareText,
  exportMarkdown,
  loadClientCredentials,
  normalizeDataUrls,
} from './spike-common';

// ── Docs REST access ──────────────────────────────────────────────────────────
//
// Called over plain HTTPS rather than through a client library: @googleapis/docs
// is not a dependency of this repo, and adding one for a go/no-go spike would be
// putting the cart before the horse. The recommendation only adds it if these
// checks pass.

const DOCS_HOST = 'docs.googleapis.com';

interface DocsResponse<T> {
  status: number;
  body: T;
  raw: string;
}

function docsRequest<T>(params: {
  accessToken: string;
  method: 'GET' | 'POST';
  pathname: string;
  payload?: unknown;
}): Promise<DocsResponse<T>> {
  return new Promise((resolve, reject) => {
    const payload = params.payload === undefined ? undefined : JSON.stringify(params.payload);
    const request = https.request(
      {
        host: DOCS_HOST,
        path: params.pathname,
        method: params.method,
        headers: {
          authorization: `Bearer ${params.accessToken}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          let body: unknown = null;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            body = null;
          }
          resolve({ status: response.statusCode ?? 0, body: body as T, raw });
        });
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

/** The API's own error message, which is what makes a FAIL line worth reading. */
function docsError(response: DocsResponse<unknown>): string {
  const message = (response.body as { error?: { message?: string } })?.error?.message;
  return `HTTP ${response.status}${message ? ` — ${message}` : ` — ${response.raw.slice(0, 200)}`}`;
}

// ── The slice of the Docs document model these checks need ────────────────────

interface TextStyle {
  weightedFontFamily?: { fontFamily?: string; weight?: number };
  fontSize?: { magnitude?: number; unit?: string };
  bold?: boolean;
  italic?: boolean;
  foregroundColor?: unknown;
  link?: unknown;
}

interface ParagraphStyle {
  namedStyleType?: string;
  alignment?: string;
  indentStart?: { magnitude?: number; unit?: string };
  spaceAbove?: { magnitude?: number; unit?: string };
  lineSpacing?: number;
}

interface ParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: { content?: string; textStyle?: TextStyle };
  inlineObjectElement?: { inlineObjectId?: string };
  footnoteReference?: unknown;
  horizontalRule?: unknown;
  equation?: unknown;
  person?: unknown;
  richLink?: unknown;
  pageBreak?: unknown;
  columnBreak?: unknown;
}

interface StructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: {
    elements?: ParagraphElement[];
    paragraphStyle?: ParagraphStyle;
    bullet?: { listId?: string; nestingLevel?: number };
    positionedObjectIds?: string[];
  };
  table?: { rows?: number; columns?: number };
  tableOfContents?: unknown;
  sectionBreak?: unknown;
}

interface DocsDocument {
  documentId?: string;
  revisionId?: string;
  title?: string;
  body?: { content?: StructuralElement[] };
  tabs?: Array<{ tabProperties?: { tabId?: string; title?: string }; childTabs?: unknown[] }>;
  inlineObjects?: Record<string, unknown>;
  positionedObjects?: Record<string, unknown>;
}

/** A body paragraph reduced to what the patch compiler would need from it. */
interface Block {
  kind: 'paragraph' | 'table' | 'tableOfContents' | 'sectionBreak' | 'unknown';
  startIndex: number;
  endIndex: number;
  /** Concatenated run text without the terminating newline; U+FFFC for objects. */
  text: string;
  paragraphStyle: ParagraphStyle;
  firstRunStyle?: TextStyle;
  hasInlineObject: boolean;
  hasPositionedObject: boolean;
  /** Footnote reference, equation, person chip, rich link, page/column break. */
  hasSpecial: boolean;
  softLineBreaks: number;
  bulleted: boolean;
  /**
   * One run-style fingerprint per character of `text`. Lets a span replacement
   * prove that every character outside the span kept its style.
   */
  charStyles: string[];
}

/** The run-level properties a patch must not disturb, in a comparable form. */
function runFingerprint(style: TextStyle | undefined): string {
  return JSON.stringify({
    f: style?.weightedFontFamily?.fontFamily,
    w: style?.weightedFontFamily?.weight,
    s: style?.fontSize?.magnitude,
    b: style?.bold,
    i: style?.italic,
    l: Boolean(style?.link),
  });
}

/** Vertical tab: what Shift+Enter inserts. One paragraph, several visual lines. */
const SOFT_LINE_BREAK = '\u000B';
const OBJECT_PLACEHOLDER = '￼';

export function flatten(document: DocsDocument): Block[] {
  const blocks: Block[] = [];

  for (const element of document.body?.content ?? []) {
    const startIndex = element.startIndex ?? 0;
    const endIndex = element.endIndex ?? 0;

    if (element.table) {
      blocks.push(emptyBlock('table', startIndex, endIndex));
      continue;
    }
    if (element.tableOfContents) {
      blocks.push(emptyBlock('tableOfContents', startIndex, endIndex));
      continue;
    }
    if (element.sectionBreak) {
      blocks.push(emptyBlock('sectionBreak', startIndex, endIndex));
      continue;
    }
    if (!element.paragraph) {
      blocks.push(emptyBlock('unknown', startIndex, endIndex));
      continue;
    }

    const elements = element.paragraph.elements ?? [];
    let text = '';
    const charStyles: string[] = [];
    let firstRunStyle: TextStyle | undefined;
    let hasInlineObject = false;
    let hasSpecial = false;

    for (const child of elements) {
      if (child.textRun) {
        const content = child.textRun.content ?? '';
        if (!firstRunStyle && content.replace(/[\n\r]/g, '').length > 0) {
          firstRunStyle = child.textRun.textStyle;
        }
        text += content;
        const fingerprint = runFingerprint(child.textRun.textStyle);
        for (let i = 0; i < content.length; i += 1) charStyles.push(fingerprint);
        continue;
      }
      if (child.inlineObjectElement) {
        hasInlineObject = true;
        text += OBJECT_PLACEHOLDER;
        charStyles.push('OBJECT');
        continue;
      }
      if (
        child.footnoteReference ||
        child.equation ||
        child.person ||
        child.richLink ||
        child.pageBreak ||
        child.columnBreak ||
        child.horizontalRule
      ) {
        hasSpecial = true;
      }
    }

    const withoutNewline = text.replace(/\n$/, '');
    blocks.push({
      kind: 'paragraph',
      startIndex,
      endIndex,
      text: withoutNewline,
      paragraphStyle: element.paragraph.paragraphStyle ?? {},
      firstRunStyle,
      hasInlineObject,
      hasPositionedObject: (element.paragraph.positionedObjectIds ?? []).length > 0,
      hasSpecial,
      softLineBreaks: withoutNewline.split(SOFT_LINE_BREAK).length - 1,
      bulleted: Boolean(element.paragraph.bullet),
      charStyles: charStyles.slice(0, withoutNewline.length),
    });
  }

  return blocks;
}

function emptyBlock(kind: Block['kind'], startIndex: number, endIndex: number): Block {
  return {
    kind,
    startIndex,
    endIndex,
    text: '',
    paragraphStyle: {},
    hasInlineObject: false,
    hasPositionedObject: false,
    hasSpecial: false,
    softLineBreaks: 0,
    bulleted: false,
    charStyles: [],
  };
}

/** Only the properties a patch would have to preserve, in a comparable form. */
export function styleFingerprint(block: Block): string {
  const paragraph = block.paragraphStyle;
  const run = block.firstRunStyle ?? {};
  return JSON.stringify({
    namedStyleType: paragraph.namedStyleType,
    alignment: paragraph.alignment,
    indentStart: paragraph.indentStart?.magnitude,
    spaceAbove: paragraph.spaceAbove?.magnitude,
    lineSpacing: paragraph.lineSpacing,
    bulleted: block.bulleted,
    fontFamily: run.weightedFontFamily?.fontFamily,
    fontWeight: run.weightedFontFamily?.weight,
    fontSize: run.fontSize?.magnitude,
    bold: run.bold,
    italic: run.italic,
  });
}

export function visible(text: string, limit = 70): string {
  // split/join rather than a regex: a control character inside a regular
  // expression is both hard to read and flagged by the linter.
  const escaped = text.split(SOFT_LINE_BREAK).join('⏎').split(OBJECT_PLACEHOLDER).join('▩').split('\t').join('→');
  return JSON.stringify(escaped.length > limit ? `${escaped.slice(0, limit)}…` : escaped);
}

// ── The spike ─────────────────────────────────────────────────────────────────

interface Args {
  fileId?: string;
  keep: boolean;
  noCopy: boolean;
}

function parseArgs(argv: string[]): Args {
  const fileIdIndex = argv.indexOf('--file-id');
  return {
    fileId: fileIdIndex >= 0 ? argv[fileIdIndex + 1] : undefined,
    keep: argv.includes('--keep'),
    noCopy: argv.includes('--no-copy'),
  };
}

/** A sentinel that cannot occur in a real document, so a no-op stays a no-op. */
const NEVER_MATCHES = '⟪choir-docs-spike-sentinel-9f3a⟫';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fileId) {
    console.error(
      'Usage: node dist-spike/docs-spike.js --file-id <documentId> [--keep] [--no-copy]\n\n' +
        'Give the id of a Google Doc this app can already reach — one it created, or one\n' +
        'you granted to it through picker-spike. The spike copies it and writes only to\n' +
        'the copy. Use the real Handbook: a synthetic fixture proves nothing about\n' +
        'drawings, custom fonts or soft line breaks.',
    );
    process.exitCode = 1;
    return;
  }

  // The whole point is the situation a background poll is in: a server that has
  // nothing but the stored refresh token. Mint a brand-new client from it rather
  // than reusing the interactive one, exactly as picker-spike does.
  const interactive = await authorize();
  const refreshToken = interactive.credentials.refresh_token;
  if (!refreshToken) {
    throw new Error(
      'No refresh token in the cached credentials. Delete scripts/spike-gdocs/.drive-spike-token.json and re-authorize.',
    );
  }
  const { clientId, clientSecret } = loadClientCredentials();
  const serverSide = new googleAuth.OAuth2(clientId, clientSecret);
  serverSide.setCredentials({ refresh_token: refreshToken });

  const accessToken = (await serverSide.getAccessToken()).token;
  if (!accessToken) {
    throw new Error('Could not mint an access token from the refresh token alone.');
  }
  const drive = driveClient({ version: 'v3', auth: serverSide });

  const results: Array<{ step: string; ok: boolean; detail: string }> = [];
  const record = (step: string, ok: boolean, detail: string) => {
    results.push({ step, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`);
  };
  const note = (step: string, detail: string) => {
    console.log(`INFO  ${step} — ${detail}`);
  };

  // ── 0. files.copy on a file this app did not create ─────────────────────────
  //
  // Phase A backs a document up before CHOIR's first write, and a native Drive
  // copy is the only same-fidelity restore point (a DOCX round trip is a
  // conversion, not a restoration). Nothing has verified copy under drive.file.
  let targetId = args.fileId;
  let copyId: string | undefined;

  if (args.noCopy) {
    note('0. files.copy', 'skipped (--no-copy): writing directly to the document you named');
  } else {
    try {
      const copied = await drive.files.copy({
        fileId: args.fileId,
        requestBody: { name: 'CHOIR docs-spike copy (safe to delete)' },
        fields: 'id, name, webViewLink',
      });
      copyId = copied.data.id ?? undefined;
      if (!copyId) throw new Error('Drive returned no id for the copy');
      targetId = copyId;
      record(
        '0. files.copy under drive.file',
        true,
        `copy=${copyId} — every write below lands here, not on the original`,
      );
    } catch (error) {
      record('0. files.copy under drive.file', false, (error as Error).message);
      console.log(
        '\nWithout a copy the remaining checks would write to your original document. Stopping.\n' +
          'Make a throwaway copy by hand and re-run with --file-id <copy> --no-copy.',
      );
      process.exitCode = 1;
      return;
    }
  }

  // ── 1. THE GATE: documents.get from a refresh-token-only client ─────────────
  const getPath = `/v1/documents/${encodeURIComponent(targetId)}?includeTabsContent=true`;
  const first = await docsRequest<DocsDocument>({ accessToken, method: 'GET', pathname: getPath });

  if (first.status !== 200) {
    record('1. documents.get (THE GATE)', false, docsError(first));
    console.log(
      '\nThe Docs API could not read this document with the drive.file grant alone.\n' +
        'If the message mentions the API not being enabled, enable the Google Docs API on the\n' +
        'same GCP project and re-run. If it is a permission error, the Picker per-file grant\n' +
        'does NOT extend to the Docs API, and docs/gdocs-format-preserving-sync.md says to stop\n' +
        'at Phase A rather than reach for the sensitive `documents` scope.',
    );
    if (copyId && !args.keep) await drive.files.delete({ fileId: copyId }).catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  const document = first.body;
  const tabCount = document.tabs?.length ?? 0;
  record(
    '1. documents.get (THE GATE)',
    true,
    `title=${JSON.stringify(document.title ?? '')} revisionId=${document.revisionId?.slice(0, 12)}… tabs=${tabCount || '(not reported)'}`,
  );

  // ── 2. batchUpdate authorized, with a batch that changes nothing ────────────
  //
  // replaceAllText against a string no document contains: it proves the write
  // path is authorized without touching a character.
  const noop = await docsRequest<{ replies?: unknown[]; writeControl?: { requiredRevisionId?: string } }>({
    accessToken,
    method: 'POST',
    pathname: `/v1/documents/${encodeURIComponent(targetId)}:batchUpdate`,
    payload: {
      requests: [{ replaceAllText: { containsText: { text: NEVER_MATCHES, matchCase: true }, replaceText: '' } }],
    },
  });
  record(
    '2. documents.batchUpdate authorized (no-op batch)',
    noop.status === 200,
    noop.status === 200
      ? `applied 0 replacements; response carries writeControl=${Boolean(noop.body?.writeControl)}`
      : docsError(noop),
  );

  // ── 3. fields mask, so the import-time tab pre-check stays cheap ────────────
  const masked = await docsRequest<DocsDocument>({
    accessToken,
    method: 'GET',
    pathname: `/v1/documents/${encodeURIComponent(targetId)}?includeTabsContent=true&fields=revisionId,tabs(tabProperties(tabId,title))`,
  });
  record(
    '3. documents.get honours a `fields` mask',
    masked.status === 200 && Boolean(masked.body?.revisionId) && masked.body?.body === undefined,
    masked.status === 200 ? `revisionId present, body omitted=${masked.body?.body === undefined}` : docsError(masked),
  );

  // ── 4. Export determinism on a richly formatted document ───────────────────
  //
  // Measured before any write, three times: everything the drift detector calls
  // "a human edited this" is `export !== baseline`, and until now that was only
  // measured on documents CHOIR itself produced from markdown.
  let exportSample = '';
  try {
    const one = await exportMarkdown(drive, targetId);
    const two = await exportMarkdown(drive, targetId);
    const three = await exportMarkdown(drive, targetId);
    exportSample = one;
    const a = compareText(one, two);
    const b = compareText(two, three);
    if (a.identical && b.identical) {
      record('4. export is byte-deterministic (×3)', true, `${one.length} bytes, identical across three exports`);
    } else {
      const normalized = compareText(normalizeDataUrls(one), normalizeDataUrls(three));
      record(
        '4. export is byte-deterministic (×3)',
        false,
        normalized.identical
          ? `differs ONLY inside base64 image payloads — normalizable. ${(a.identical ? b : a).summary}`
          : (a.identical ? b : a).summary,
      );
    }
  } catch (error) {
    record('4. export is byte-deterministic (×3)', false, (error as Error).message);
  }

  // ── Pick a paragraph the later write checks can safely work on ─────────────
  const blocks = flatten(document);
  const paragraphs = blocks.filter((block) => block.kind === 'paragraph');
  const editable = paragraphs.filter(
    (block) =>
      block.text.replace(/\s/g, '').length >= 20 &&
      !block.hasInlineObject &&
      !block.hasPositionedObject &&
      !block.hasSpecial,
  );
  const subject = editable[0];
  const lastParagraph = [...paragraphs].reverse().find((block) => block.endIndex > block.startIndex);

  // ── 5. Does a content-changing batchUpdate bump Drive's `version`? ─────────
  //
  // The poller treats a version bump as its only trigger; if an in-place patch
  // does not bump it, CHOIR's own writes become invisible to the drift check and
  // the baseline it records is never revisited.
  if (subject) {
    try {
      const before = await drive.files.get({ fileId: targetId, fields: 'version' });
      const marker = ' ⟪spike⟫';
      const inserted = await docsRequest<unknown>({
        accessToken,
        method: 'POST',
        pathname: `/v1/documents/${encodeURIComponent(targetId)}:batchUpdate`,
        payload: { requests: [{ insertText: { location: { index: subject.endIndex - 1 }, text: marker } }] },
      });
      if (inserted.status !== 200) {
        record('5. batchUpdate bumps Drive version', false, docsError(inserted));
      } else {
        const after = await drive.files.get({ fileId: targetId, fields: 'version' });
        const bumped = before.data.version !== after.data.version;
        record(
          '5. batchUpdate bumps Drive version',
          bumped,
          bumped
            ? `${before.data.version} → ${after.data.version} — the poller's trigger still fires`
            : `stayed ${after.data.version} — the poller would NOT notice a patched document`,
        );
        // Put it back.
        await docsRequest<unknown>({
          accessToken,
          method: 'POST',
          pathname: `/v1/documents/${encodeURIComponent(targetId)}:batchUpdate`,
          payload: {
            requests: [
              {
                deleteContentRange: {
                  range: { startIndex: subject.endIndex - 1, endIndex: subject.endIndex - 1 + marker.length },
                },
              },
            ],
          },
        });
      }
    } catch (error) {
      record('5. batchUpdate bumps Drive version', false, (error as Error).message);
    }
  } else {
    note('5. batchUpdate bumps Drive version', 'skipped: no plain prose paragraph long enough to probe');
  }

  // ── 6. The write fence: a stale requiredRevisionId must be refused ─────────
  const stale = await docsRequest<unknown>({
    accessToken,
    method: 'POST',
    pathname: `/v1/documents/${encodeURIComponent(targetId)}:batchUpdate`,
    payload: {
      requests: [{ replaceAllText: { containsText: { text: NEVER_MATCHES, matchCase: true }, replaceText: '' } }],
      // The revision read before check 5's write, which has since moved on.
      writeControl: { requiredRevisionId: document.revisionId },
    },
  });
  record(
    '6. stale requiredRevisionId is refused',
    stale.status === 400,
    stale.status === 400
      ? 'HTTP 400 as documented — the fence holds'
      : `expected 400, got ${stale.status}. ${stale.status === 200 ? 'THE FENCE DOES NOT HOLD — a concurrent human edit could be overwritten' : docsError(stale)}`,
  );

  // ── 7. Rewriting a paragraph's text without losing its formatting ──────────
  //
  // Three ways to change a paragraph's words, from finest to coarsest. Each is a
  // candidate primitive for the patch compiler, and each is measured for whether
  // the ParagraphStyle and the run styles survive:
  //
  //   7a. SPAN replacement — only the characters that differ are touched; every
  //       run before and after the span must keep its style. This is "change the
  //       text, keep the style" in its strongest form, and it is what keeps an
  //       italic word or a hyperlink alive in a paragraph CHOIR edits.
  //   7b. Insert the new text just before the terminating newline, THEN delete the
  //       old text. The inserted text inherits from the paragraph's own last run.
  //   7c. Delete the old text, THEN insert at the paragraph start. The inserted
  //       text inherits from whatever precedes the paragraph — likely the previous
  //       paragraph's last run, which is the leak the compiler must guard against.
  const batchPath = `/v1/documents/${encodeURIComponent(targetId)}:batchUpdate`;
  const batch = (requests: unknown[]) =>
    docsRequest<unknown>({ accessToken, method: 'POST', pathname: batchPath, payload: { requests } });
  const relocate = async (startIndex: number): Promise<Block | undefined> => {
    const latest = await docsRequest<DocsDocument>({ accessToken, method: 'GET', pathname: getPath });
    const found = flatten(latest.body).find((block) => block.startIndex === startIndex);
    return found?.kind === 'paragraph' ? found : undefined;
  };

  if (!subject) {
    note('7. paragraph rewrite', 'skipped: no plain prose paragraph long enough to probe');
  } else {
    const original = await relocate(subject.startIndex);
    const originalFingerprint = original ? styleFingerprint(original) : '';

    // 7a — span replacement on the untouched original, where mixed runs (a bold
    // word, a link, the "Make"/"ability" split in a title) are still present.
    if (!original) {
      record('7a. span replacement keeps surrounding runs', false, 'could not re-locate the subject paragraph');
    } else {
      const words = original.text.split(' ');
      if (words.length < 3) {
        note('7a. span replacement keeps surrounding runs', 'skipped: paragraph has fewer than three words');
      } else {
        const prefix = `${words[0]} `;
        const oldMiddle = words[1];
        const newMiddle = 'SPIKE';
        const spanStart = original.startIndex + prefix.length;
        const response = await batch([
          // Insert AFTER the old span so the new text inherits the old span's
          // own trailing style, then remove the old span. The delete's indices
          // are unaffected because the insert landed after them.
          { insertText: { location: { index: spanStart + oldMiddle.length }, text: newMiddle } },
          { deleteContentRange: { range: { startIndex: spanStart, endIndex: spanStart + oldMiddle.length } } },
        ]);

        if (response.status !== 200) {
          record('7a. span replacement keeps surrounding runs', false, docsError(response));
        } else {
          const after = await relocate(original.startIndex);
          const expectedText = prefix + newMiddle + original.text.slice(prefix.length + oldMiddle.length);
          const outsideBefore = [
            ...original.charStyles.slice(0, prefix.length),
            ...original.charStyles.slice(prefix.length + oldMiddle.length),
          ];
          const outsideAfter = after
            ? [...after.charStyles.slice(0, prefix.length), ...after.charStyles.slice(prefix.length + newMiddle.length)]
            : [];
          const textOk = after?.text === expectedText;
          const runsOk = JSON.stringify(outsideBefore) === JSON.stringify(outsideAfter);
          const paragraphOk = after ? styleFingerprint(after) === originalFingerprint : false;
          const distinctRuns = new Set(original.charStyles).size;
          record(
            '7a. span replacement keeps surrounding runs',
            textOk && runsOk && paragraphOk,
            [
              `text ${textOk ? 'ok' : `WRONG: ${after ? visible(after.text) : '(gone)'}`}`,
              `runs outside span ${runsOk ? 'untouched' : 'CHANGED'}`,
              `paragraph style ${paragraphOk ? 'kept' : 'CHANGED'}`,
              `(${distinctRuns} distinct run style(s) in the original — ${distinctRuns > 1 ? 'a real mixed-run test' : 'single run, so the run check is weak; try a paragraph with a link or a bold word'})`,
            ].join('; '),
          );
          if (after) {
            const inherited = after.charStyles[prefix.length];
            const fromPrefix = original.charStyles[prefix.length - 1];
            note(
              '7a. inserted span inherited',
              inherited === fromPrefix
                ? 'the style of the character before it (prefix end)'
                : `a different style than the prefix end: ${inherited}`,
            );
          }
        }
      }
    }

    // 7b — whole-paragraph rewrite, insert-then-delete.
    const beforeB = await relocate(subject.startIndex);
    if (!beforeB) {
      record('7b. insert-then-delete keeps paragraph style', false, 'could not re-locate the subject paragraph');
    } else {
      const textB = 'CHOIR spike rewrite, inserted before the newline and then the old text deleted.';
      const response = await batch([
        { insertText: { location: { index: beforeB.endIndex - 1 }, text: textB } },
        {
          deleteContentRange: {
            range: { startIndex: beforeB.startIndex, endIndex: beforeB.startIndex + beforeB.text.length },
          },
        },
      ]);
      if (response.status !== 200) {
        record('7b. insert-then-delete keeps paragraph style', false, docsError(response));
      } else {
        const after = await relocate(beforeB.startIndex);
        const fingerprint = after ? styleFingerprint(after) : '(paragraph gone)';
        const kept = fingerprint === originalFingerprint;
        record(
          '7b. insert-then-delete keeps paragraph style',
          kept && after?.text === textB,
          kept
            ? `style preserved: ${originalFingerprint}`
            : `style CHANGED\n      before: ${originalFingerprint}\n      after:  ${fingerprint}`,
        );
      }
    }

    // 7c — whole-paragraph rewrite, delete-then-insert at the paragraph start.
    const beforeC = await relocate(subject.startIndex);
    if (!beforeC) {
      record('7c. delete-then-insert keeps paragraph style', false, 'could not re-locate the subject paragraph');
    } else {
      const textC = 'CHOIR spike rewrite, old text deleted first and the new text inserted at the start.';
      const response = await batch([
        // Keep the terminating newline: it is what carries the paragraph.
        { deleteContentRange: { range: { startIndex: beforeC.startIndex, endIndex: beforeC.endIndex - 1 } } },
        { insertText: { location: { index: beforeC.startIndex }, text: textC } },
      ]);
      if (response.status !== 200) {
        record('7c. delete-then-insert keeps paragraph style', false, docsError(response));
      } else {
        const after = await relocate(beforeC.startIndex);
        const fingerprint = after ? styleFingerprint(after) : '(paragraph gone)';
        const kept = fingerprint === originalFingerprint;
        const previous = [...blocks]
          .reverse()
          .find((block) => block.kind === 'paragraph' && block.endIndex <= beforeC.startIndex);
        record(
          '7c. delete-then-insert keeps paragraph style',
          kept && after?.text === textC,
          kept
            ? `style preserved: ${originalFingerprint}`
            : `style CHANGED — inserted text took its style from outside the paragraph\n      before:   ${originalFingerprint}\n      after:    ${fingerprint}\n      previous: ${previous ? styleFingerprint(previous) : '(none)'}`,
        );
      }
    }
  }

  // ── 8. Where a new paragraph may be inserted ───────────────────────────────
  //
  // Google documents that text must be inserted inside the bounds of an existing
  // Paragraph. Appending a section is the most common CHOIR-side update, so the
  // anchoring rule decides whether that update can ever be published.
  if (lastParagraph) {
    const latest = await docsRequest<DocsDocument>({ accessToken, method: 'GET', pathname: getPath });
    const currentBlocks = flatten(latest.body);
    const tail = [...currentBlocks].reverse().find((block) => block.kind === 'paragraph');
    const bodyEnd = currentBlocks.length ? currentBlocks[currentBlocks.length - 1].endIndex : 0;

    if (tail) {
      const appended = '\nCHOIR spike appended paragraph.';
      const inside = await docsRequest<unknown>({
        accessToken,
        method: 'POST',
        pathname: `/v1/documents/${encodeURIComponent(targetId)}:batchUpdate`,
        payload: { requests: [{ insertText: { location: { index: tail.endIndex - 1 }, text: appended } }] },
      });
      record(
        '8a. insert at lastParagraph.endIndex - 1',
        inside.status === 200,
        inside.status === 200 ? 'accepted — this is the correct anchor for appending a section' : docsError(inside),
      );
      if (inside.status === 200) {
        await docsRequest<unknown>({
          accessToken,
          method: 'POST',
          pathname: `/v1/documents/${encodeURIComponent(targetId)}:batchUpdate`,
          payload: {
            requests: [
              {
                deleteContentRange: {
                  range: { startIndex: tail.endIndex - 1, endIndex: tail.endIndex - 1 + appended.length },
                },
              },
            ],
          },
        });
      }

      const outside = await docsRequest<unknown>({
        accessToken,
        method: 'POST',
        pathname: `/v1/documents/${encodeURIComponent(targetId)}:batchUpdate`,
        payload: { requests: [{ insertText: { location: { index: bodyEnd }, text: 'nope' } }] },
      });
      record(
        '8b. insert at the body end index is refused',
        outside.status !== 200,
        outside.status !== 200
          ? `refused as expected — ${docsError(outside)}`
          : 'ACCEPTED — unexpected; re-read the insertion rules before trusting the compiler',
      );
      if (outside.status === 200) {
        await docsRequest<unknown>({
          accessToken,
          method: 'POST',
          pathname: `/v1/documents/${encodeURIComponent(targetId)}:batchUpdate`,
          payload: { requests: [{ deleteContentRange: { range: { startIndex: bodyEnd, endIndex: bodyEnd + 4 } } }] },
        });
      }
    }
  }

  // ── 9. What this document is actually made of ─────────────────────────────
  const tables = blocks.filter((block) => block.kind === 'table').length;
  const sectionBreaks = blocks.filter((block) => block.kind === 'sectionBreak').length;
  const withObjects = paragraphs.filter((block) => block.hasInlineObject || block.hasPositionedObject).length;
  const withSpecial = paragraphs.filter((block) => block.hasSpecial).length;
  const withSoftBreaks = paragraphs.filter((block) => block.softLineBreaks > 0);
  const empty = paragraphs.filter((block) => block.text.trim() === '').length;

  console.log('\n--- 9. Structure inventory ---');
  console.log(`  paragraphs:            ${paragraphs.length} (of which ${empty} are empty/spacing)`);
  console.log(`  tables:                ${tables}`);
  console.log(`  section breaks:        ${sectionBreaks}`);
  console.log(`  paragraphs w/ images:  ${withObjects}   (inline or positioned objects)`);
  console.log(`  paragraphs w/ special: ${withSpecial}   (footnotes, equations, chips, breaks)`);
  console.log(`  paragraphs w/ soft line breaks: ${withSoftBreaks.length}`);
  console.log(`  tabs reported:         ${tabCount || '(none — single tab, or not reported)'}`);

  if (withSoftBreaks.length) {
    console.log('\n  Soft line breaks matter: one Doc paragraph, several export lines, so a');
    console.log('  line-by-line alignment will not key-match these. First few:');
    for (const block of withSoftBreaks.slice(0, 5)) {
      console.log(`    @${block.startIndex} (${block.softLineBreaks} break(s)) ${visible(block.text, 90)}`);
    }
  }

  console.log('\n--- First 12 blocks, as the patch compiler would see them ---');
  for (const block of blocks.slice(0, 12)) {
    const style = block.paragraphStyle.namedStyleType ?? block.kind.toUpperCase();
    const alignment = block.paragraphStyle.alignment ? ` ${block.paragraphStyle.alignment}` : '';
    const font = block.firstRunStyle?.weightedFontFamily?.fontFamily;
    const marks = [
      block.hasInlineObject ? 'IMG' : '',
      block.hasPositionedObject ? 'POS' : '',
      block.hasSpecial ? 'SPECIAL' : '',
      block.bulleted ? 'BULLET' : '',
    ]
      .filter(Boolean)
      .join(',');
    console.log(
      `  [${block.startIndex}-${block.endIndex}] ${style}${alignment}${font ? ` "${font}"` : ''}${marks ? ` {${marks}}` : ''} ${visible(block.text)}`,
    );
  }

  console.log('\n--- First 12 export lines, for comparison ---');
  for (const [index, line] of exportSample.split('\n').slice(0, 12).entries()) {
    console.log(`  ${String(index + 1).padStart(2)} ${visible(line, 90)}`);
  }
  console.log(
    '\n  Read these two lists side by side. Each non-blank export line should correspond to\n' +
      '  exactly one paragraph block. Where it does not — a centred byline written with\n' +
      '  Shift+Enter, an image paragraph exporting as a reference, a table — that is a\n' +
      '  construct the compiler has to refuse rather than guess at.',
  );

  if (exportSample) {
    const dumpPath = path.join(SPIKE_SOURCE_DIR, 'docs-spike-export.md');
    try {
      fs.writeFileSync(dumpPath, exportSample, 'utf-8');
      console.log(`\nExport written to ${dumpPath}`);
    } catch {
      // Non-essential.
    }
  }

  if (copyId && !args.keep) {
    await drive.files.delete({ fileId: copyId }).catch(() => undefined);
    console.log('Deleted the spike copy (pass --keep to inspect what the writes did to it).');
  } else if (copyId) {
    console.log(`\nKept the copy: https://docs.google.com/document/d/${copyId}/edit`);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('Failed:');
    for (const result of failed) console.log(`  - ${result.step}`);
  }
  process.exitCode = failed.length > 0 ? 1 : 0;
}

// Guarded so the pure helpers above can be imported and exercised without the
// script trying to authorize against Google.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
