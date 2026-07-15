import { isoWeek, isoWeekOf } from 'services/dashboard/iso-week';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe('isoWeek', () => {
  it('labels a mid-year date', () => {
    expect(isoWeek(utc(2026, 7, 15))).toBe('2026-W29');
  });

  it('handles year-boundary weeks that belong to the adjacent ISO year', () => {
    expect(isoWeek(utc(2026, 1, 1))).toBe('2026-W01'); // Thursday → own year
    expect(isoWeek(utc(2021, 1, 1))).toBe('2020-W53'); // Friday → previous ISO year (2020 has 53 weeks)
    expect(isoWeek(utc(2023, 1, 1))).toBe('2022-W52'); // Sunday → previous ISO year
    expect(isoWeek(utc(2024, 12, 30))).toBe('2025-W01'); // Monday → next ISO year
    expect(isoWeek(utc(2020, 12, 31))).toBe('2020-W53');
  });

  it('zero-pads the week number', () => {
    expect(isoWeek(utc(2026, 1, 5))).toBe('2026-W02');
  });

  it('isoWeekOf matches isoWeek for the same instant', () => {
    const d = utc(2026, 7, 15);
    expect(isoWeekOf(d.getTime())).toBe(isoWeek(d));
  });
});
