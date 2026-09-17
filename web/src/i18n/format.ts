/**
 * Locale-aware dates for the viewer.
 *
 * This replaces the hand-rolled `relativeTime()` that lived in HistoryPanel.
 * Its buckets are kept exactly as they were — under a minute, then minutes,
 * hours, days, then an absolute date past a week — because they are a product
 * decision; what changes is that the words come from `Intl` instead of from
 * concatenated English (`'5m ago'` cannot be made to read as Korean, and
 * `toLocaleDateString()` with no locale follows the browser rather than the
 * reader's CHOIR language setting).
 *
 * Formatter construction is the expensive part, so instances are cached per
 * locale.
 */

import type { Locale } from './supported-locales';
import { translate } from './translate';

const MINUTE_MS = 60_000;
const HOUR_MIN = 60;
const DAY_HR = 24;
const WEEK_DAYS = 7;

const relativeByLocale = new Map<Locale, Intl.RelativeTimeFormat>();
const dateByLocale = new Map<Locale, Intl.DateTimeFormat>();

function relativeFor(locale: Locale): Intl.RelativeTimeFormat {
  const cached = relativeByLocale.get(locale);
  if (cached) return cached;
  // `numeric: 'auto'` is what turns "1 day ago" into "yesterday" (and "1일 전"
  // into "어제"); `style: 'narrow'` keeps it short enough for the one-line
  // record subtitle it sits in.
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
  relativeByLocale.set(locale, formatter);
  return formatter;
}

function dateFor(locale: Locale): Intl.DateTimeFormat {
  const cached = dateByLocale.get(locale);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale);
  dateByLocale.set(locale, formatter);
  return formatter;
}

/** An absolute date in the reader's locale. Empty string for an unparseable value. */
export function formatDate(locale: Locale, date: string | number | Date): string {
  const time = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (Number.isNaN(time)) return '';
  return dateFor(locale).format(time);
}

/**
 * How long ago something happened, in the reader's locale. Anything older than
 * a week is given as a date instead: "38 days ago" is a worse answer than the
 * day it actually was.
 *
 * `now` is a parameter so the buckets can be tested without freezing the clock.
 */
export function formatRelative(locale: Locale, date: string | number | Date, now: number = Date.now()): string {
  const time = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (Number.isNaN(time)) return '';

  const minutes = Math.round((now - time) / MINUTE_MS);
  if (minutes < 1) return translate(locale, 'history.time.justNow');
  if (minutes < HOUR_MIN) return relativeFor(locale).format(-minutes, 'minute');

  const hours = Math.round(minutes / HOUR_MIN);
  if (hours < DAY_HR) return relativeFor(locale).format(-hours, 'hour');

  const days = Math.round(hours / DAY_HR);
  if (days < WEEK_DAYS) return relativeFor(locale).format(-days, 'day');

  return formatDate(locale, time);
}
