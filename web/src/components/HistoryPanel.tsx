import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProvenanceListItem, ProvenanceRecord, ProvenanceType } from '../types';
import { lineDiff } from '../utils/diff';
import { encodePath } from '../utils/docs';

type HistoryPanelProps = {
  workspaceId: string;
  filePath: string;
  open: boolean;
  authenticated: boolean;
  onClose: () => void;
  onSignIn: () => void;
};

const TYPE_LABEL: Record<ProvenanceType, string> = {
  update: 'Update',
  append: 'Append',
  'new-file': 'New file',
  'web-edit': 'Manual edit',
};

type SortKey = 'newest' | 'size';
type DateKey = 'all' | '1d' | '7d' | '30d';

const DATE_MS: Record<Exclude<DateKey, 'all'>, number> = {
  '1d': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function speakerName(p: { username?: string; userId?: string }): string {
  return p.username ?? p.userId ?? 'Unknown';
}

function HistoryDetail({ record }: { record: ProvenanceRecord }) {
  const [view, setView] = useState<'diff' | 'before' | 'after'>('diff');
  const diff = useMemo(() => lineDiff(record.diff.before, record.diff.after), [record]);

  return (
    <div className="history-detail">
      {record.knowledge.trim() && (
        <section className="history-section">
          <h4 className="history-section-title">Extracted knowledge</h4>
          <p className="history-knowledge">{record.knowledge}</p>
        </section>
      )}

      {record.messages.length > 0 && (
        <section className="history-section">
          <h4 className="history-section-title">Conversation</h4>
          <ul className="history-conversation">
            {record.messages.map((m, idx) => (
              <li key={`${m.ts ?? idx}`} className="history-message">
                <span className="history-speaker">{speakerName(m)}</span>
                <span className="history-text">{m.text ?? ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="history-section">
        <div className="history-section-head">
          <h4 className="history-section-title">Changes</h4>
          <fieldset className="history-toggle" aria-label="Change view mode">
            {(['diff', 'before', 'after'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={`history-toggle-btn${view === k ? ' active' : ''}`}
                onClick={() => setView(k)}
              >
                {k === 'diff' ? 'Diff' : k === 'before' ? 'Before' : 'After'}
              </button>
            ))}
          </fieldset>
        </div>

        {view === 'diff' ? (
          diff.length === 0 ? (
            <p className="history-empty-inline">No changes to show.</p>
          ) : (
            <pre className="history-diff">
              {diff.map((line, idx) => (
                <code key={`${line.type}-${idx}`} className={`diff-line diff-${line.type}`}>
                  {line.type === 'add' ? '+ ' : '- '}
                  {line.text}
                </code>
              ))}
            </pre>
          )
        ) : (
          <pre className="history-plain">
            {view === 'before' ? record.diff.before || '(no previous content)' : record.diff.after}
          </pre>
        )}
      </section>
    </div>
  );
}

export function HistoryPanel({ workspaceId, filePath, open, authenticated, onClose, onSignIn }: HistoryPanelProps) {
  const [records, setRecords] = useState<ProvenanceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [userFilter, setUserFilter] = useState('all');
  const [sort, setSort] = useState<SortKey>('newest');
  const [dateRange, setDateRange] = useState<DateKey>('all');

  useEffect(() => {
    if (!open || !authenticated) return;
    let cancelled = false;
    setRecords(null);
    setError(null);
    setExpandedId(null);
    setSearch('');
    setUserFilter('all');
    setSort('newest');
    setDateRange('all');

    fetch(`/api/docs/${encodeURIComponent(workspaceId)}/provenance/${encodePath(filePath)}`, {
      credentials: 'same-origin',
    })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) throw new Error('AUTH');
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<{ records: ProvenanceListItem[] }>;
      })
      .then((data) => {
        if (!cancelled) setRecords(data.records);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error && e.message === 'AUTH' ? 'AUTH' : 'load');
      });

    return () => {
      cancelled = true;
    };
  }, [open, authenticated, workspaceId, filePath]);

  const sizes = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of records ?? []) m[r.id] = lineDiff(r.diff.before, r.diff.after).length;
    return m;
  }, [records]);

  const userOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of records ?? []) {
      const uid = r.updatedBy?.userId ?? r.updatedBy?.name;
      if (uid) map.set(uid, r.updatedBy?.name ?? r.updatedBy?.userId ?? uid);
    }
    return [...map.entries()];
  }, [records]);

  const filtered = useMemo(() => {
    if (!records) return [];
    const q = search.trim().toLowerCase();
    const cutoff = dateRange === 'all' ? 0 : Date.now() - DATE_MS[dateRange];

    const list = records.filter((r) => {
      if (userFilter !== 'all' && (r.updatedBy?.userId ?? r.updatedBy?.name) !== userFilter) return false;
      if (cutoff) {
        const t = new Date(r.createdAt).getTime();
        if (!Number.isNaN(t) && t < cutoff) return false;
      }
      if (q) {
        const hay = [
          r.updatedBy?.name,
          r.updatedBy?.userId,
          TYPE_LABEL[r.type],
          r.knowledge,
          ...(r.messages?.map((m) => `${m.username ?? ''} ${m.text ?? ''}`) ?? []),
          r.diff?.before,
          r.diff?.after,
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return [...list].sort((a, b) =>
      sort === 'size' ? (sizes[b.id] ?? 0) - (sizes[a.id] ?? 0) : (b.createdAt || '').localeCompare(a.createdAt || ''),
    );
  }, [records, search, userFilter, dateRange, sort, sizes]);

  const toggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  if (!open) return null;

  const showToolbar = authenticated && !error && records !== null && records.length > 0;

  return (
    <aside className="history-panel" aria-label="Change history">
      <header className="history-panel-head">
        <span className="history-panel-title">Change history</span>
        <button type="button" className="doc-iconbutton" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {showToolbar && (
        <div className="history-toolbar">
          <input
            type="search"
            className="history-search"
            placeholder="Search conversation, knowledge, changes"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="history-filters">
            <select
              className="history-select"
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              aria-label="Filter by author"
            >
              <option value="all">All authors</option>
              {userOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              className="history-select"
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value as DateKey)}
              aria-label="Filter by date"
            >
              <option value="all">All time</option>
              <option value="1d">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
            <select
              className="history-select"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort"
            >
              <option value="newest">Newest</option>
              <option value="size">Change size</option>
            </select>
          </div>
        </div>
      )}

      <div className="history-panel-body">
        {!authenticated ? (
          <div className="history-empty">
            <p>Change history is visible to workspace members only.</p>
            <button type="button" className="doc-button doc-button-primary" onClick={onSignIn}>
              Sign in with Slack
            </button>
          </div>
        ) : error === 'AUTH' ? (
          <div className="history-empty">
            <p>Only members of this workspace can view the change history.</p>
            <button type="button" className="doc-button doc-button-primary" onClick={onSignIn}>
              Sign in again
            </button>
          </div>
        ) : error === 'load' ? (
          <p className="history-empty">Failed to load history.</p>
        ) : records === null ? (
          <p className="history-empty">Loading…</p>
        ) : records.length === 0 ? (
          <p className="history-empty">No change history yet.</p>
        ) : filtered.length === 0 ? (
          <p className="history-empty">No history matches your filters.</p>
        ) : (
          filtered.map((rec) => (
            <article key={rec.id} className={`history-item${expandedId === rec.id ? ' expanded' : ''}`}>
              <button type="button" className="history-item-head" onClick={() => toggle(rec.id)}>
                <span className={`history-badge type-${rec.type}`}>{TYPE_LABEL[rec.type] ?? rec.type}</span>
                <span className="history-item-meta">
                  <span className="history-item-who">{rec.updatedBy?.name ?? rec.updatedBy?.userId ?? 'Unknown'}</span>
                  <span className="history-item-sub">
                    {relativeTime(rec.createdAt)} · {sizes[rec.id] ?? 0} lines changed
                  </span>
                </span>
                <span className="history-item-caret">{expandedId === rec.id ? '▾' : '▸'}</span>
              </button>
              {expandedId === rec.id && <HistoryDetail record={rec} />}
            </article>
          ))
        )}
      </div>
    </aside>
  );
}
