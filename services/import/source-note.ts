import { detectDocumentLanguage } from 'services/common/language';
import { resolveContentLanguage } from 'services/i18n/resolve-locale';
import { type Locale, translate } from '../../src/i18n';
import type { ImportSourceInfo } from './types';

/**
 * The line that says where an imported document came from.
 *
 * An import is the one way a document enters the repository without an author,
 * so the body has to carry its own provenance: a reader who finds a claim in it
 * needs to be able to go check the original, and the retrieval index — which
 * reads the file, not the commit — needs the URL in the text to be able to cite
 * it. The commit message says the same thing, but a commit message is invisible
 * from inside the viewer and from inside an answer.
 *
 * One blockquote line, under the title, and the manager can delete it in the
 * preview. It is a note, not a contract.
 */

/**
 * What makes a line ours.
 *
 * Marker rather than text matching, for the reason `services/google/banner.ts`
 * learned the hard way: the sentence is translated, dated and interpolated, so
 * every wording change or a reader touching the line would defeat a text match.
 * An HTML comment is invisible in every markdown renderer (the viewer, GitHub,
 * Google Docs) and survives a remark round trip as a raw html node, so it costs
 * the reader nothing and still identifies the line exactly. It sits at the end
 * so the sentence — the part a person reads — starts the line.
 */
export const SOURCE_NOTE_MARKER = '<!-- choir:source -->';

export interface SourceNoteOptions {
  /** The document's language, from {@link pickDocumentLanguage}. */
  language: Locale;
  /** Defaults to now. The date the import happened, not the source's own date. */
  date?: Date;
}

export function buildSourceNote(source: ImportSourceInfo, opts: SourceNoteOptions): string {
  const { language } = opts;
  const date = formatDate(opts.date ?? new Date());
  const name = oneLine(source.name);

  return `> ${sentence(source, { language, date, name })} ${SOURCE_NOTE_MARKER}`;
}

function sentence(source: ImportSourceInfo, ctx: { language: Locale; date: string; name: string }): string {
  const { language, date, name } = ctx;

  if (source.kind === 'url') {
    // The bare URL rather than the page title: it is what a reader needs to
    // click, and what retrieval can cite.
    return translate(language, 'import.sourceNote.url', { url: oneLine(source.url ?? name), date });
  }

  if (source.kind === 'google-docs') {
    // A Doc has no address a reader can guess, so the name is only useful linked.
    const label = source.url ? `[${escapeLinkText(name)}](${oneLine(source.url)})` : name;
    return translate(language, 'import.sourceNote.googleDoc', { name: label, date });
  }

  if (source.kind === 'meeting') {
    // How long it ran and how many people spoke, in that order — the two facts
    // that tell a reader whether the note stands for the whole meeting. Either
    // may be missing (a pasted transcript has no clock), and with neither this
    // is just a file, so it falls through to the plain sentence.
    const detail = [
      typeof source.minutes === 'number' && source.minutes > 0
        ? translate(language, 'import.sourceNote.minutes', { count: source.minutes })
        : '',
      typeof source.speakers === 'number' && source.speakers > 0
        ? translate(language, 'import.sourceNote.speakers', { count: source.speakers })
        : '',
    ]
      .filter(Boolean)
      .join(', ');

    if (detail) {
      return translate(language, 'import.sourceNote.fileWithDetail', { name, detail, date });
    }
    return translate(language, 'import.sourceNote.file', { name, date });
  }

  if (typeof source.pages === 'number' && source.pages > 0) {
    const pages = translate(language, 'import.sourceNote.pages', { count: source.pages });
    return translate(language, 'import.sourceNote.fileWithPages', { name, pages, date });
  }

  return translate(language, 'import.sourceNote.file', { name, date });
}

/**
 * Puts the note under the title.
 *
 * After the first `# ` heading rather than at the very top, because the title is
 * what the viewer's file list and every reader see first; a provenance line
 * above it reads as the document's opening sentence. A body with no heading has
 * no title to stay out of the way of, so the note goes first.
 */
export function prependSourceNote(markdown: string, note: string): string {
  const body = stripSourceNote(markdown);
  const lines = body.split('\n');
  const heading = lines.findIndex((line) => /^#\s+\S/.test(line));

  if (heading === -1) {
    return `${note}\n\n${body.replace(/^\n+/, '')}`;
  }

  const after = lines.slice(heading + 1);
  // The blank line the heading already had is reused rather than doubled.
  while (after.length > 0 && after[0].trim() === '') after.shift();

  return [...lines.slice(0, heading + 1), '', note, '', ...after].join('\n');
}

/** Takes the note back out, wherever it ended up. */
export function stripSourceNote(markdown: string): string {
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) => line.includes(SOURCE_NOTE_MARKER));
  if (index === -1) return markdown;

  const before = lines.slice(0, index);
  const after = lines.slice(index + 1);

  // The blank line that separated the note from the body goes with it; without
  // this, stripping and re-prepending grows a gap every time. At the top of the
  // document there is no line before the note, so the separator is still its own.
  const openedTheDocument = before.length === 0 || before[before.length - 1].trim() === '';
  if (openedTheDocument && after.length > 0 && after[0].trim() === '') {
    after.shift();
  }

  return [...before, ...after].join('\n');
}

/**
 * The language the note is written in.
 *
 * The same rule as the Google Docs banner (`bannerLanguage` in
 * services/google/replica-publisher.ts): the note is content, so it follows the
 * workspace's content-language policy, and under `follow-conversation` the
 * document speaks for itself. Reimplemented here rather than imported because
 * `bannerLanguage` lives in a module that pulls in Drive, GitHub and the
 * workspace mirror — the whole replica stack behind a two-line decision — and
 * import has no reason to load any of it.
 */
export async function pickDocumentLanguage(workspaceId: string, markdown: string): Promise<Locale> {
  let policy: 'follow-conversation' | Locale;
  try {
    policy = await resolveContentLanguage(workspaceId);
  } catch {
    policy = 'follow-conversation';
  }

  if (policy !== 'follow-conversation') return policy;
  // `detectDocumentLanguage` knows languages CHOIR has no strings for; those
  // fall back to English, the same as an unset policy.
  return detectDocumentLanguage(markdown) === 'ko' ? 'ko' : 'en';
}

/** Local date, because the note is dated in the workspace's own day, not UTC's. */
function formatDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** A filename or page title from a source can hold anything; the note is one line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** `]` in a Doc's name would close the link early and leave the rest as prose. */
function escapeLinkText(value: string): string {
  return value.replace(/([[\]])/g, '\\$1');
}
