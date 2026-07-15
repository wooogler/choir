/**
 * ISO-8601 week label utilities. The dashboard never exposes a finer time
 * resolution than the week — a precise timestamp on a small team can re-identify
 * who asked what — so events are bucketed into `YYYY-Www` (e.g. `2026-W03`).
 */

/**
 * ISO-8601 week-numbering year + week for a date, formatted `YYYY-Www`.
 * ISO weeks start Monday; week 1 is the week containing the first Thursday of the
 * year, so early-January and late-December dates can belong to the adjacent year.
 */
export function isoWeek(date: Date): string {
  // Work in UTC to avoid the host timezone shifting the day-of-week.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO weekday: Mon=1..Sun=7.
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Shift to the Thursday of this week: the week's ISO year is that Thursday's year.
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** ISO week label for an epoch-ms timestamp. */
export function isoWeekOf(epochMs: number): string {
  return isoWeek(new Date(epochMs));
}
