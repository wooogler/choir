/**
 * The React bindings around `translate.ts`: one provider at the root, `useT()`
 * everywhere else.
 *
 * Where the locale comes from, in order:
 *   1. `?lang=ko` — an explicit override, and it *stays* the winner for the
 *      rest of the visit. Somebody who asked for a language in the URL (to
 *      check a translation, or because they are sharing a link) should not have
 *      it yanked away a moment later when the session responds.
 *   2. the browser's own language, so the first paint is already right.
 *   3. `GET /api/docs/session`'s `language`, which is the reader's CHOIR
 *      setting and therefore the real answer; it arrives a beat late and is
 *      applied by whichever screen fetched the session.
 *
 * `localStorage` is deliberately not in that list: the server preference is the
 * source of truth, and a stale copy in one browser would quietly disagree with
 * Slack and with the App Home language picker.
 */

import { Fragment, type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LOCALE, type Locale, normalizeLocale } from './supported-locales';
import { PLACEHOLDER, type T, createT } from './translate';

export { formatDate, formatRelative } from './format';
export {
  type T,
  catalogs,
  createT,
  hasTranslation,
  isPluralForms,
  selectPluralForm,
  translate,
} from './translate';
export type {
  Catalog,
  LocaleCatalog,
  MessageKey,
  MessageValue,
  ParamValue,
  Params,
  PluralForms,
  PluralParams,
  TranslateArgs,
} from './types';
export {
  DEFAULT_LOCALE,
  type Locale,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
} from './supported-locales';

type LocaleContextValue = {
  locale: Locale;
  /** Set the locale outright. Ignored while `?lang=` is pinning it. */
  setLocale: (locale: Locale) => void;
  /**
   * Adopt the language the session endpoint reported. Screens call this from
   * their existing `/api/docs/session` handler, so the provider costs no extra
   * request.
   */
  applySessionLanguage: (language: string | null | undefined) => void;
};

/** Query parameter that pins the locale for the visit. */
const LANG_PARAM = 'lang';

function readPinnedLocale(): Locale | undefined {
  if (typeof window === 'undefined') return undefined;
  return normalizeLocale(new URLSearchParams(window.location.search).get(LANG_PARAM));
}

function readBrowserLocale(): Locale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  return normalizeLocale(navigator.language) ?? DEFAULT_LOCALE;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  applySessionLanguage: () => {},
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  // Read once: re-reading the URL on every render would re-pin after an
  // in-app pushState that drops the parameter.
  const [pinned] = useState<Locale | undefined>(readPinnedLocale);
  const [locale, setLocaleState] = useState<Locale>(() => pinned ?? readBrowserLocale());

  const setLocale = useCallback(
    (next: Locale) => {
      if (pinned) return;
      setLocaleState((current) => (current === next ? current : next));
    },
    [pinned],
  );

  const applySessionLanguage = useCallback(
    (language: string | null | undefined) => {
      const next = normalizeLocale(language);
      if (next) setLocale(next);
    },
    [setLocale],
  );

  // Screen readers, `:lang()` rules and the browser's own hyphenation all read
  // this, so it has to follow the locale rather than be set once in index.html.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, applySessionLanguage }),
    [locale, setLocale, applySessionLanguage],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** The current locale plus the two ways to change it. */
export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

/** A translator bound to the current locale. Rebuilt only when the locale moves. */
export function useT(): T {
  const { locale } = useContext(LocaleContext);
  return useMemo(() => createT(locale), [locale]);
}

/**
 * Fills a translated string's `{name}` holes with React nodes.
 *
 * For the handful of sentences that carry markup inside them — a `<code>` path,
 * a bolded warning. Splitting those into "before" and "after" fragments would
 * freeze English word order into the layout; this way the translator moves the
 * hole and the markup follows.
 *
 * A hole with no matching node is left verbatim, exactly as `t` leaves an
 * unfilled placeholder.
 */
export function fillNodes(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  // A fresh regex per call: PLACEHOLDER is global, so a shared `lastIndex`
  // would make the second call on the same string start halfway through it.
  const pattern = new RegExp(PLACEHOLDER.source, 'g');
  let match = pattern.exec(template);
  while (match) {
    const node = nodes[match[1]];
    if (node !== undefined) {
      if (match.index > cursor) out.push(template.slice(cursor, match.index));
      index += 1;
      // A keyed Fragment rather than a <span>: the substituted markup lands in
      // the DOM exactly where it would have been written by hand.
      out.push(<Fragment key={`${match[1]}-${index}`}>{node}</Fragment>);
      cursor = match.index + match[0].length;
    }
    match = pattern.exec(template);
  }
  if (cursor < template.length) out.push(template.slice(cursor));
  return out;
}
