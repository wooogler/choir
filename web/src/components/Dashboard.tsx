import { useEffect, useMemo, useState } from 'react';
import { useLocale, useT } from '../i18n';
import type { DashboardSummary, DocUsageResponse, GapsResponse, SessionInfo, TopicsResponse } from '../types';
import { docsPath, navigate } from '../utils/docs';
import { GapCards, HBars, Meter, StatTile, WeeklyBars } from './dashboard/charts';

function redirectToSignIn(workspaceId: string): void {
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.href = `/docs/auth/slack/start?workspaceId=${encodeURIComponent(workspaceId)}&next=${encodeURIComponent(next)}`;
}

async function fetchJson<T>(url: string, workspaceId: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) {
    redirectToSignIn(workspaceId);
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T;
}

type DashboardProps = { workspaceId: string; fromFilePath?: string };

export function Dashboard({ workspaceId, fromFilePath }: DashboardProps) {
  const t = useT();
  const { locale, applySessionLanguage } = useLocale();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [topics, setTopics] = useState<TopicsResponse | null>(null);
  const [gaps, setGaps] = useState<GapsResponse | null>(null);
  const [docUsage, setDocUsage] = useState<DocUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/docs/session', { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<SessionInfo>) : Promise.reject(new Error(`${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setSession(data);
        // The reader's CHOIR language setting, which outranks the browser's own
        // preference the provider started with.
        applySessionLanguage(data.language);
      })
      .catch(() => !cancelled && setSession({ authenticated: false }));
    return () => {
      cancelled = true;
    };
  }, [applySessionLanguage]);

  const canView = session?.authenticated === true && session.isChoirUser;

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    (async () => {
      try {
        // Topic labels are localized server-side, so the reader's language is
        // part of the request — and moving it has to refetch, not just re-render.
        const lang = `?lang=${encodeURIComponent(locale)}`;
        const [s, t, g, d] = await Promise.all([
          fetchJson<DashboardSummary>(`/api/dashboard/${workspaceId}/summary${lang}`, workspaceId),
          fetchJson<TopicsResponse>(`/api/dashboard/${workspaceId}/topics${lang}`, workspaceId),
          fetchJson<GapsResponse>(`/api/dashboard/${workspaceId}/gaps${lang}`, workspaceId),
          fetchJson<DocUsageResponse>(`/api/dashboard/${workspaceId}/doc-usage`, workspaceId),
        ]);
        if (cancelled) return;
        setSummary(s);
        setTopics(t);
        setGaps(g);
        setDocUsage(d);
      } catch (err) {
        if (!cancelled && (err as Error).message !== 'unauthorized') setError(t('dashboard.error.load'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canView, workspaceId, locale, t]);

  const goDocs = () => {
    if (fromFilePath) navigate(docsPath(workspaceId, fromFilePath));
    else window.history.back();
  };

  const topicItems = useMemo(
    () =>
      (topics?.topics ?? []).slice(0, 12).map((topic) => ({
        key: topic.topicId,
        label: topic.label,
        // Marks an English label sitting in a Korean page (no translation stored).
        lang: topic.labelLocale,
        value: topic.total,
        answered: topic.answered,
        title: t('dashboard.topic.tooltip', {
          label: topic.label,
          count: topic.total,
          answered: topic.answered,
          representative: topic.representative,
        }),
      })),
    [topics, t],
  );

  const docItems = useMemo(
    () =>
      (docUsage?.files ?? []).slice(0, 12).map((f) => ({
        key: f.fileName,
        label: f.fileName,
        value: f.retrievals,
        title: t('dashboard.doc.tooltip', {
          label: f.fileName,
          count: f.retrievals,
          unanswered: f.unanswered,
          week: f.lastWeek,
        }),
      })),
    [docUsage, t],
  );

  return (
    <div className="dashboard-shell">
      <header className="doc-topbar">
        <div className="doc-topbar-left">
          <nav className="dash-tabs" aria-label={t('dashboard.aria.views')}>
            <button type="button" className="dash-tab" onClick={goDocs}>
              {t('dashboard.tab.docs')}
            </button>
            <button type="button" className="dash-tab active" aria-current="page">
              {t('dashboard.tab.insights')}
            </button>
          </nav>
        </div>
      </header>

      <main className="dashboard">
        {session === null && <p className="dash-empty">{t('common.loading')}</p>}

        {session?.authenticated === false && (
          <div className="doc-notice">
            <p>{t('dashboard.signIn.prompt')}</p>
            <button
              type="button"
              className="doc-button doc-button-primary"
              onClick={() => redirectToSignIn(workspaceId)}
            >
              {t('dashboard.signIn.button')}
            </button>
          </div>
        )}

        {session?.authenticated === true && !session.isChoirUser && (
          <div className="doc-notice">{t('dashboard.membersOnly')}</div>
        )}

        {error && <div className="doc-notice doc-notice-error">{error}</div>}

        {canView && summary && (
          <>
            <h1 className="dash-h1">{t('dashboard.title')}</h1>

            <section className="dash-stats">
              <StatTile label={t('dashboard.stat.questions')} value={String(summary.totals.questions)} />
              <StatTile label={t('dashboard.stat.answered')} value={pctLabel(summary.totals.answeredRatio)}>
                <Meter ratio={summary.totals.answeredRatio} />
              </StatTile>
              <StatTile label={t('dashboard.stat.topics')} value={String(summary.totals.activeTopics)} />
            </section>

            <section className="dash-section">
              <h2 className="dash-h2">{t('dashboard.section.weekly')}</h2>
              <WeeklyBars weeks={summary.weeks} />
            </section>

            <section className="dash-section">
              <h2 className="dash-h2">{t('dashboard.section.topics')}</h2>
              <p className="dash-sub">{t('dashboard.section.topics.sub')}</p>
              <HBars items={topicItems} legend />
            </section>

            <section className="dash-section">
              <h2 className="dash-h2">{t('dashboard.section.gaps')}</h2>
              <p className="dash-sub">{t('dashboard.section.gaps.sub')}</p>
              <GapCards gaps={gaps?.gaps ?? []} />
            </section>

            <section className="dash-section">
              <h2 className="dash-h2">{t('dashboard.section.docUsage')}</h2>
              <p className="dash-sub">{t('dashboard.section.docUsage.sub')}</p>
              <HBars items={docItems} />
            </section>

            <footer className="dash-footnote">{t('dashboard.footnote')}</footer>
          </>
        )}
      </main>
    </div>
  );
}

function pctLabel(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
