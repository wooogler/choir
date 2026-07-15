import type { ReactNode } from 'react';
import type { GapView } from '../../types';

/** '2026-W29' -> 'W29' for compact axis labels. */
function shortWeek(isoWeek: string): string {
  const parts = isoWeek.split('-');
  return parts[1] ?? isoWeek;
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function StatTile({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="dash-stat">
      <div className="dash-stat-value">{value}</div>
      <div className="dash-stat-label">{label}</div>
      {children}
    </div>
  );
}

/** Answered-ratio meter: green fill on a neutral track. Not color-alone — the % is shown. */
export function Meter({ ratio }: { ratio: number }) {
  return (
    <div className="dash-meter" role="img" aria-label={`${pct(ratio)} answered`}>
      <div className="dash-meter-fill" style={{ width: pct(ratio) }} />
    </div>
  );
}

/** Vertical bars: questions per week (single hue). Value labels are always shown. */
export function WeeklyBars({ weeks }: { weeks: Array<{ isoWeek: string; total: number; answered: number }> }) {
  if (weeks.length === 0) return <p className="dash-empty">No questions in this period yet.</p>;
  const max = Math.max(1, ...weeks.map((w) => w.total));
  return (
    <div className="dash-weekly" role="img" aria-label="Questions per week">
      {weeks.map((w) => (
        <div
          key={w.isoWeek}
          className="dash-weekly-col"
          title={`${w.isoWeek}: ${w.total} question${w.total === 1 ? '' : 's'}, ${w.answered} answered`}
        >
          <div className="dash-weekly-value">{w.total}</div>
          <div className="dash-weekly-bar-wrap">
            <div className="dash-weekly-bar" style={{ height: `${(w.total / max) * 100}%` }} />
          </div>
          <div className="dash-weekly-x">{shortWeek(w.isoWeek)}</div>
        </div>
      ))}
    </div>
  );
}

export interface HBarItem {
  key: string | number;
  label: string;
  value: number;
  /** If set, the bar splits into answered (green) + unanswered (amber) summing to `value`. */
  answered?: number;
  title?: string;
}

/** Horizontal bars for topics / documents. Length encodes magnitude. */
export function HBars({ items, legend }: { items: HBarItem[]; legend?: boolean }) {
  if (items.length === 0) return <p className="dash-empty">Nothing to show yet.</p>;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div>
      {legend && (
        <div className="dash-legend">
          <span className="dash-legend-item">
            <span className="dash-swatch answered" /> answered
          </span>
          <span className="dash-legend-item">
            <span className="dash-swatch unanswered" /> unanswered
          </span>
        </div>
      )}
      <ul className="dash-hbars">
        {items.map((it) => {
          const answered = it.answered ?? it.value;
          const unanswered = it.answered != null ? it.value - it.answered : 0;
          return (
            <li key={it.key} className="dash-hbar-row" title={it.title ?? `${it.label}: ${it.value}`}>
              <div className="dash-hbar-label">{it.label}</div>
              <div className="dash-hbar-track">
                {it.answered != null ? (
                  <>
                    <span className="dash-hbar-fill answered" style={{ width: `${(answered / max) * 100}%` }} />
                    <span className="dash-hbar-fill unanswered" style={{ width: `${(unanswered / max) * 100}%` }} />
                  </>
                ) : (
                  <span className="dash-hbar-fill neutral" style={{ width: `${(it.value / max) * 100}%` }} />
                )}
              </div>
              <div className="dash-hbar-value">{it.value}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Gap cards: topics students ask about that documentation doesn't answer. */
export function GapCards({ gaps }: { gaps: GapView[] }) {
  if (gaps.length === 0) return <p className="dash-empty">No documentation gaps surfaced in this period. 🎉</p>;
  return (
    <ul className="dash-gaps">
      {gaps.map((g) => (
        <li key={g.topicId} className="dash-gap-card">
          <div className="dash-gap-head">
            <span className="dash-gap-title">{g.label}</span>
            <span className="dash-gap-badge">{g.unanswered} unanswered</span>
          </div>
          <p className="dash-gap-rep">{g.representative}</p>
          {g.relatedDocs.length > 0 && (
            <div className="dash-gap-docs">
              <span className="dash-gap-docs-label">Searched but insufficient:</span>
              <ul>
                {g.relatedDocs.map((d, i) => (
                  <li key={`${d.fileName}-${i}`}>
                    {d.fileName}
                    {d.headingPath ? ` › ${d.headingPath}` : ''} <span className="dash-muted">×{d.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
