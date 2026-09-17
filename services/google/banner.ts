/**
 * The notice prepended to every replica, and the rules for taking it back off.
 *
 * The banner is content as far as Google Docs is concerned, so it comes back in
 * every export and would show up in every diff. Both sides of a comparison are
 * stripped before use.
 *
 * Stripping matches structurally rather than by exact string. An exact match
 * breaks twice: the day the wording changes, every stored baseline still holds
 * the old text and every document reports a banner-only drift; and a reader who
 * edits the banner line — the most likely thing a confused person touches —
 * defeats the match on one side only, so their mangled banner reads as an
 * addition and can be committed to the repository.
 */

import type { Locale } from '../../src/i18n/supported-locales';

/**
 * The `preserve` counterpart to the banner, written to the file's Drive
 * `description` instead of into the body.
 *
 * A document whose formatting must survive cannot carry a banner: the banner is
 * body text, so writing it would be the single edit CHOIR makes to a document it
 * promised not to edit, and it would show up in every export and every diff. The
 * description says the same thing from outside the document.
 */
export const LINK_DESCRIPTION =
  'Linked to CHOIR. Edits made here are reviewed by a manager before they reach the repository.';

export const LINK_DESCRIPTION_KO =
  'CHOIR에 연결된 문서입니다. 여기서 수정한 내용은 관리자 검토를 거쳐 저장소에 반영됩니다.';

export const REPLICA_BANNER =
  '*This document is a read-only replica of a GitHub document, synced by CHOIR. ' +
  'Edits made here are not applied directly — they are sent to a manager for review.*';

export const REPLICA_BANNER_KO =
  '*이 문서는 CHOIR가 동기화하는 GitHub 문서의 읽기 전용 사본입니다. ' +
  '여기서 수정한 내용은 바로 반영되지 않고, 관리자 검토로 전달됩니다.*';

/**
 * Anything that has ever been used as the banner's opening. Matching the opening
 * rather than the whole sentence means later wording changes do not invalidate
 * baselines written by earlier deploys; add to this list, never replace it.
 */
const BANNER_OPENINGS = [
  'This document is a read-only replica',
  // Pre-release Korean wording, kept so early baselines still strip cleanly.
  '이 문서는 GitHub에서 자동 생성된 복제본입니다',
  '이 문서는 CHOIR가 동기화하는 GitHub 문서의 읽기 전용 사본입니다',
];

/**
 * A banner line as it survives a Docs round trip: the italic markers may be lost
 * or doubled, and Docs escapes some punctuation, so only the opening is anchored.
 */
function isBannerLine(line: string): boolean {
  const bare = line
    .trim()
    .replace(/^[*_]+/, '')
    .replace(/\\/g, '');
  return BANNER_OPENINGS.some((opening) => bare.startsWith(opening));
}

export interface StrippedBanner {
  /** The document without its banner (and without the blank line that followed). */
  body: string;
  /** False when the banner was missing — someone deleted it, or this is not a replica. */
  hadBanner: boolean;
}

export function stripBanner(markdown: string): StrippedBanner {
  const lines = markdown.split('\n');

  let index = 0;
  while (index < lines.length && lines[index].trim() === '') {
    index += 1;
  }

  if (index >= lines.length || !isBannerLine(lines[index])) {
    return { body: markdown, hadBanner: false };
  }

  index += 1;
  while (index < lines.length && lines[index].trim() === '') {
    index += 1;
  }

  return { body: lines.slice(index).join('\n'), hadBanner: true };
}

/**
 * Prepends the banner, replacing any banner already present.
 *
 * The banner is written into someone's document, so it follows the workspace's
 * content language rather than CHOIR's UI language. A language with no banner of
 * its own falls back to English; switching a workspace's language rewrites the
 * banner on the next publish, which `stripBanner` absorbs because every opening
 * ever shipped is still matched.
 */
export function withBanner(markdown: string, language: Locale = 'en'): string {
  const { body } = stripBanner(markdown);
  return `${bannerFor(language)}\n\n${body}`;
}

function bannerFor(language: Locale): string {
  return language === 'ko' ? REPLICA_BANNER_KO : REPLICA_BANNER;
}

/** The `preserve` counterpart to {@link withBanner}, for the Drive description. */
export function linkDescription(language: Locale = 'en'): string {
  return language === 'ko' ? LINK_DESCRIPTION_KO : LINK_DESCRIPTION;
}
