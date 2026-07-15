import { useEffect, useMemo, useState } from 'react';
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
      .then((data) => !cancelled && setSession(data))
      .catch(() => !cancelled && setSession({ authenticated: false }));
    return () => {
      cancelled = true;
    };
  }, []);

  const canView = session?.authenticated === true && session.isChoirUser;

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    (async () => {
      try {
        const [s, t, g, d] = await Promise.all([
          fetchJson<DashboardSummary>(`/api/dashboard/${workspaceId}/summary`, workspaceId),
          fetchJson<TopicsResponse>(`/api/dashboard/${workspaceId}/topics`, workspaceId),
          fetchJson<GapsResponse>(`/api/dashboard/${workspaceId}/gaps`, workspaceId),
          fetchJson<DocUsageResponse>(`/api/dashboard/${workspaceId}/doc-usage`, workspaceId),
        ]);
        if (cancelled) return;
        setSummary(s);
        setTopics(t);
        setGaps(g);
        setDocUsage(d);
      } catch (err) {
        if (!cancelled && (err as Error).message !== 'unauthorized') setError('Could not load dashboard data.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canView, workspaceId]);

  const goDocs = () => {
    if (fromFilePath) navigate(docsPath(workspaceId, fromFilePath));
    else window.history.back();
  };

  const topicItems = useMemo(
    () =>
      (topics?.topics ?? []).slice(0, 12).map((t) => ({
        key: t.topicId,
        label: t.label,
        value: t.total,
        answered: t.answered,
        title: `${t.label}: ${t.total} question${t.total === 1 ? '' : 's'}, ${t.answered} answered — “${t.representative}”`,
      })),
    [topics],
  );

  const docItems = useMemo(
    () =>
      (docUsage?.files ?? []).slice(0, 12).map((f) => ({
        key: f.fileName,
        label: f.fileName,
        value: f.retrievals,
        title: `${f.fileName}: retrieved ${f.retrievals} time${f.retrievals === 1 ? '' : 's'}, ${f.unanswered} when the answer fell short (last ${f.lastWeek})`,
      })),
    [docUsage],
  );

  return (
    <div className="dashboard-shell">
      <header className="doc-topbar">
        <div className="doc-topbar-left">
          <nav className="dash-tabs" aria-label="Views">
            <button type="button" className="dash-tab" onClick={goDocs}>
              Docs
            </button>
            <button type="button" className="dash-tab active" aria-current="page">
              Insights
            </button>
          </nav>
        </div>
      </header>

      <main className="dashboard">
        {session === null && <p className="dash-empty">Loading…</p>}

        {session?.authenticated === false && (
          <div className="doc-notice">
            <p>Sign in to view team insights.</p>
            <button
              type="button"
              className="doc-button doc-button-primary"
              onClick={() => redirectToSignIn(workspaceId)}
            >
              Sign in
            </button>
          </div>
        )}

        {session?.authenticated === true && !session.isChoirUser && (
          <div className="doc-notice">Insights are available to registered CHOIR members.</div>
        )}

        {error && <div className="doc-notice doc-notice-error">{error}</div>}

        {canView && summary && (
          <>
            <h1 className="dash-h1">Team insights</h1>

            <section className="dash-stats">
              <StatTile label="Questions asked" value={String(summary.totals.questions)} />
              <StatTile label="Answered from docs" value={pctLabel(summary.totals.answeredRatio)}>
                <Meter ratio={summary.totals.answeredRatio} />
              </StatTile>
              <StatTile label="Active topics" value={String(summary.totals.activeTopics)} />
            </section>

            <section className="dash-section">
              <h2 className="dash-h2">Questions per week</h2>
              <WeeklyBars weeks={summary.weeks} />
            </section>

            <section className="dash-section">
              <h2 className="dash-h2">Top topics</h2>
              <p className="dash-sub">What the team asks about most. Answered from the docs vs. still unanswered.</p>
              <HBars items={topicItems} legend />
            </section>

            <section className="dash-section">
              <h2 className="dash-h2">Documentation gaps</h2>
              <p className="dash-sub">Frequently asked topics the documentation could not answer.</p>
              <GapCards gaps={gaps?.gaps ?? []} />
            </section>

            <section className="dash-section">
              <h2 className="dash-h2">Document usage</h2>
              <p className="dash-sub">Which documents CHOIR draws on to answer questions.</p>
              <HBars items={docItems} />
            </section>

            <footer className="dash-footnote">
              Aggregated by topic and week. No individual activity is shown. Topics asked by fewer than 2 people are
              grouped as “Other”.
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

function pctLabel(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
