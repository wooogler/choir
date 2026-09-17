/**
 * The workspace's content-language policy, expressed as a prompt sentence.
 *
 * CHOIR's prompts have always pinned the output language to whatever the input
 * was written in — the conversation, the knowledge, the section being edited.
 * That is still the default (`follow-conversation`), and for it the sentences
 * below are byte-for-byte the ones the prompts carried before this file existed:
 * a policy nobody set must not quietly reword a prompt.
 *
 * When a manager picks a fixed language the sentence flips from "follow the
 * input" to "write in X regardless of the input", and the model is told what it
 * must still not translate — names in quotes, URLs, code. File names are ruled
 * by their own prompt line and stay English either way.
 */

import { languageName } from 'services/common/language';
import { resolveContentLanguage } from 'services/i18n/resolve-locale';
import type { Locale } from '../../src/i18n/supported-locales';

export type ContentLanguagePolicy = 'follow-conversation' | Locale;

/**
 * The workspace's policy, or `follow-conversation` when it has none — and also
 * when the lookup fails. A missing workspace config or an unreadable store is a
 * reason to keep today's behaviour, never a reason to fail a document edit.
 */
export async function getContentLanguagePolicy(workspaceId?: string): Promise<ContentLanguagePolicy> {
  if (!workspaceId) return 'follow-conversation';
  try {
    return await resolveContentLanguage(workspaceId);
  } catch {
    return 'follow-conversation';
  }
}

export interface ContentLanguageOptions {
  /** Which input the prompt currently tells the model to follow. */
  source: 'conversation' | 'knowledge' | 'existing-content';
  /**
   * What the sentence says is being written ("the initial content", "the
   * section title and content"). Only used for `knowledge`, whose three call
   * sites word this differently; omitted, the sentence has no object at all
   * ("Write in the same language as the knowledge").
   */
  subject?: string;
  /**
   * Appended verbatim to the `follow-conversation` sentence for `knowledge` —
   * the trailing period, or the "unless the FILE/SECTION context…" caveat. It
   * has no fixed-locale counterpart: under a fixed locale the configured
   * language outranks the caveats.
   */
  followSuffix?: string;
}

/** What the model must carry across untranslated, whatever the target language. */
const VERBATIM = 'Keep quoted names, URLs and code verbatim.';

/** The sentence to drop into a prompt in place of the old hardcoded one. */
export function contentLanguageDirective(policy: ContentLanguagePolicy, opts: ContentLanguageOptions): string {
  const { source, subject, followSuffix = '' } = opts;

  if (policy === 'follow-conversation') {
    switch (source) {
      case 'conversation':
        return '- Write in the SAME language as the conversation. If the conversation is in Korean, write the output in Korean.';
      case 'knowledge':
        return `- Write${subject ? ` ${subject}` : ''} in the same language as the knowledge${followSuffix}`;
      case 'existing-content':
        return "- Write the result in the language of the EXISTING content. If the knowledge is in a different language, translate it faithfully into the existing content's language; never leave mixed-language output";
    }
  }

  const name = languageName(policy);
  const object = subject ?? 'the output';

  switch (source) {
    case 'conversation':
      return `- Write ${object} in ${name}, regardless of the language of the conversation. ${VERBATIM}`;
    case 'knowledge':
      return `- Write ${object} in ${name}, regardless of the language of the knowledge. ${VERBATIM}`;
    case 'existing-content':
      return (
        `- Write the result in ${name}. If the EXISTING content is already in ${name}, keep its wording and style and merge the knowledge into it; ` +
        `if the existing content is in another language, write the merged result in ${name} anyway, translating both the existing content and the knowledge faithfully. ` +
        `Never leave mixed-language output. ${VERBATIM}`
      );
  }
}
