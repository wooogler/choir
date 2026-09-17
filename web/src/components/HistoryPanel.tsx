import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatRelative, useLocale, useT } from '../i18n';
import type { T } from '../i18n';
import type { ProvenanceListItem, ProvenanceRecord, ProvenanceType } from '../types';
import { changedLineCount, lineDiff } from '../utils/diff';
import { encodePath } from '../utils/docs';

type HistoryPanelProps = {
  workspaceId: string;
  filePath: string;
  open: boolean;
  authenticated: boolean;
  focusId?: string;
  focusKey?: number;
  onClose: () => void;
  onSignIn: () => void;
};

/**
 * The record kinds, as catalog keys rather than labels: the badge, the search
 * haystack and any future filter all go through `t` from here, so a kind is
 * named once and translated everywhere it appears.
 */
const TYPE_KEY = {
  update: 'history.type.update',
  append: 'history.type.append',
  'new-file': 'history.type.newFile',
  'web-edit': 'history.type.webEdit',
  'gdocs-edit': 'history.type.gdocsEdit',
} as const satisfies Record<ProvenanceType, Parameters<T>[0]>;

function typeLabel(t: T, type: ProvenanceType): string {
  const key = TYPE_KEY[type];
  // An unknown kind from a newer server has no key; show the raw value rather
  // than an empty badge.
  return key ? t(key) : type;
}

type SortKey = 'newest' | 'size';
type DateKey = 'all' | '1d' | '7d' | '30d';

const DATE_MS: Record<Exclude<DateKey, 'all'>, number> = {
  '1d': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

function speakerName(t: T, p: { username?: string; userId?: string }): string {
  return p.username ?? p.userId ?? t('common.unknownUser');
}

function HistoryDetail({ record }: { record: ProvenanceRecord }) {
  const t = useT();
  const [view, setView] = useState<'diff' | 'before' | 'after'>('diff');
  const diff = useMemo(() => lineDiff(record.diff.before, record.diff.after), [record]);

  return (
    <div className="history-detail">
      {record.knowledge.trim() && (
        <section className="history-section">
          <h4 className="history-section-title">{t('history.section.knowledge')}</h4>
          <p className="history-knowledge">{record.knowledge}</p>
        </section>
      )}

      {record.messages.length > 0 && (
        <section className="history-section">
          <h4 className="history-section-title">{t('history.section.conversation')}</h4>
          <ul className="history-conversation">
            {record.messages.map((m, idx) => (
              <li key={`${m.ts ?? idx}`} className="history-message">
                <span className="history-speaker">{speakerName(t, m)}</span>
                <span className="history-text">{m.text ?? ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="history-section">
        <div className="history-section-head">
          <h4 className="history-section-title">{t('history.section.changes')}</h4>
          <fieldset className="history-toggle" aria-label={t('history.aria.viewMode')}>
            {(['diff', 'before', 'after'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={`history-toggle-btn${view === k ? ' active' : ''}`}
                onClick={() => setView(k)}
              >
                {k === 'diff'
                  ? t('history.view.diff')
                  : k === 'before'
                    ? t('history.view.before')
                    : t('history.view.after')}
              </button>
            ))}
          </fieldset>
        </div>

        {view === 'diff' ? (
          diff.length === 0 ? (
            <p className="history-empty-inline">{t('history.diff.empty')}</p>
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
            {view === 'before' ? record.diff.before || t('history.diff.noPrevious') : record.diff.after}
          </pre>
        )}
      </section>
    </div>
  );
}

export function HistoryPanel({
  workspaceId,
  filePath,
  open,
  authenticated,
  focusId,
  focusKey,
  onClose,
  onSignIn,
}: HistoryPanelProps) {
  const t = useT();
  const { locale } = useLocale();
  const [records, setRecords] = useState<ProvenanceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [userFilter, setUserFilter] = useState('all');
  const [sort, setSort] = useState<SortKey>('newest');
  const [dateRange, setDateRange] = useState<DateKey>('all');
  // The last focusKey we've already acted on, so re-renders (e.g. records
  // reloading on panel reopen) don't re-fire a stale marker focus.
  const handledFocusKeyRef = useRef<number | null | undefined>(null);

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
    // Cheap O(n) estimate; the full lineDiff is computed lazily per expanded record.
    for (const r of records ?? []) m[r.id] = changedLineCount(r.diff.before, r.diff.after);
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
        // Not `t`: that name now belongs to the translator this closure uses.
        const created = new Date(r.createdAt).getTime();
        if (!Number.isNaN(created) && created < cutoff) return false;
      }
      if (q) {
        const hay = [
          r.updatedBy?.name,
          r.updatedBy?.userId,
          typeLabel(t, r.type),
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
  }, [records, search, userFilter, dateRange, sort, sizes, t]);

  const toggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  // When a gutter marker is clicked, expand and scroll to its record. focusKey is
  // an intentional re-trigger nonce so clicking the same marker re-focuses; the
  // handled-key ref stops a stale focus re-firing on unrelated re-renders.
  useEffect(() => {
    if (!focusId || !records) return;
    // Only act on a genuinely new marker click. Without this, reopening the panel
    // (which re-fetches records → new array reference) would re-fire the stale
    // focus and jump the user to a previously-clicked record.
    if (focusKey === handledFocusKeyRef.current) return;
    handledFocusKeyRef.current = focusKey;

    // The target record may be hidden by an active filter/search, which would make
    // the click silently do nothing. Clear filters so it's always revealed.
    setSearch('');
    setUserFilter('all');
    setDateRange('all');
    setExpandedId(focusId);

    // Scroll after the filter reset has re-rendered the (possibly newly visible)
    // row into the DOM.
    const raf = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-record-id="${focusId}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [focusKey, focusId, records]);

  if (!open) return null;

  const showToolbar = authenticated && !error && records !== null && records.length > 0;

  return (
    <aside className="history-panel" aria-label={t('history.aria.panel')}>
      <header className="history-panel-head">
        <span className="history-panel-title">{t('history.title')}</span>
        <button type="button" className="doc-iconbutton" onClick={onClose} aria-label={t('history.aria.close')}>
          ✕
        </button>
      </header>

      {showToolbar && (
        <div className="history-toolbar">
          <input
            type="search"
            className="history-search"
            placeholder={t('history.search.placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="history-filters">
            <select
              className="history-select"
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              aria-label={t('history.aria.filterAuthor')}
            >
              <option value="all">{t('history.filter.allAuthors')}</option>
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
              aria-label={t('history.aria.filterDate')}
            >
              <option value="all">{t('history.filter.allTime')}</option>
              <option value="1d">{t('history.filter.last24h')}</option>
              <option value="7d">{t('history.filter.last7d')}</option>
              <option value="30d">{t('history.filter.last30d')}</option>
            </select>
            <select
              className="history-select"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label={t('history.aria.sort')}
            >
              <option value="newest">{t('history.sort.newest')}</option>
              <option value="size">{t('history.sort.size')}</option>
            </select>
          </div>
        </div>
      )}

      <div className="history-panel-body">
        {!authenticated ? (
          <div className="history-empty">
            <p>{t('history.empty.membersOnly')}</p>
            <button type="button" className="doc-button doc-button-primary" onClick={onSignIn}>
              {t('history.button.signIn')}
            </button>
          </div>
        ) : error === 'AUTH' ? (
          <div className="history-empty">
            <p>{t('history.empty.authRequired')}</p>
            <button type="button" className="doc-button doc-button-primary" onClick={onSignIn}>
              {t('history.button.signInAgain')}
            </button>
          </div>
        ) : error === 'load' ? (
          <p className="history-empty">{t('history.empty.loadFailed')}</p>
        ) : records === null ? (
          <p className="history-empty">{t('common.loading')}</p>
        ) : records.length === 0 ? (
          <p className="history-empty">{t('history.empty.none')}</p>
        ) : filtered.length === 0 ? (
          <p className="history-empty">{t('history.empty.noMatches')}</p>
        ) : (
          filtered.map((rec) => (
            <article
              key={rec.id}
              data-record-id={rec.id}
              className={`history-item${expandedId === rec.id ? ' expanded' : ''}`}
            >
              <button type="button" className="history-item-head" onClick={() => toggle(rec.id)}>
                <span className={`history-badge type-${rec.type}`}>{typeLabel(t, rec.type)}</span>
                <span className="history-item-meta">
                  <span className="history-item-who">
                    {rec.updatedBy?.name ?? rec.updatedBy?.userId ?? t('common.unknownUser')}
                  </span>
                  <span className="history-item-sub">
                    {formatRelative(locale, rec.createdAt)} · {t('history.linesChanged', { count: sizes[rec.id] ?? 0 })}
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
