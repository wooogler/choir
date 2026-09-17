import { type Locale, isSupportedLocale } from '../../src/i18n/supported-locales';

/**
 * Validation for the viewer's language settings endpoint.
 *
 * Kept out of the route so the rules can be read and tested without booting the
 * HTTP app: which fields were asked for, whether they are values we support,
 * and whether answering them needs a manager. The route stays the part that
 * knows about sessions and storage.
 */

/** 'auto' clears a personal preference back to the Slack locale. */
export type PersonalLanguageChoice = 'auto' | Locale;

/** A document-content policy: follow each conversation, or pin one language. */
export type ContentLanguageChoice = 'follow-conversation' | Locale;

export interface LanguageUpdate {
  mine?: PersonalLanguageChoice;
  workspace?: Locale;
  content?: ContentLanguageChoice;
}

export type ParsedLanguageUpdate =
  | { ok: true; update: LanguageUpdate }
  | { ok: false; code: 'invalid_language'; field: 'mine' | 'workspace' | 'content' };

/**
 * Reads a request body into the fields it actually asks to change. An absent
 * field is left alone rather than reset, so the dialog can send only what the
 * reader touched.
 */
export function parseLanguageUpdate(body: unknown): ParsedLanguageUpdate {
  const { mine, workspace, content } = (body ?? {}) as Record<string, unknown>;
  const update: LanguageUpdate = {};

  if (mine !== undefined) {
    if (mine !== 'auto' && !isSupportedLocale(mine)) {
      return { ok: false, code: 'invalid_language', field: 'mine' };
    }
    update.mine = mine as PersonalLanguageChoice;
  }

  if (workspace !== undefined) {
    if (!isSupportedLocale(workspace)) {
      return { ok: false, code: 'invalid_language', field: 'workspace' };
    }
    update.workspace = workspace;
  }

  if (content !== undefined) {
    if (content !== 'follow-conversation' && !isSupportedLocale(content)) {
      return { ok: false, code: 'invalid_language', field: 'content' };
    }
    update.content = content as ContentLanguageChoice;
  }

  return { ok: true, update };
}

/**
 * True when the update touches something that belongs to the whole workspace.
 * A personal language is nobody else's business, so it needs no manager check.
 */
export function needsManager(update: LanguageUpdate): boolean {
  return update.workspace !== undefined || update.content !== undefined;
}
