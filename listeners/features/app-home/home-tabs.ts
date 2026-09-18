/**
 * Which App Home tab a person is looking at.
 *
 * Slack's Home tab is a single published view, so "tabs" are ours: a row of
 * buttons at the top and a record of which one is active. The record lives in
 * memory, keyed by workspace and user, because it is a navigation preference —
 * losing it on restart just puts everyone back on Home, which is where a fresh
 * visitor starts anyway. Storing it also keeps the tab across the modal
 * round-trips (`refreshAppHome*` republishes whatever tab the person was on).
 *
 * Three of the four tabs are manager-only. Reading the stored tab therefore
 * takes the caller's manager verdict and falls back to Home when someone has
 * been demoted since they last clicked — the render-side half of the gate whose
 * enforcing half lives in the `home_tab:` action handler.
 */

export type HomeTab = 'home' | 'documents' | 'team' | 'advanced';

/** Display order of the tab bar. */
export const HOME_TABS: readonly HomeTab[] = ['home', 'documents', 'team', 'advanced'];

const MANAGER_ONLY_TABS: ReadonlySet<HomeTab> = new Set<HomeTab>(['documents', 'team', 'advanced']);

export const isHomeTab = (value: unknown): value is HomeTab =>
  typeof value === 'string' && (HOME_TABS as readonly string[]).includes(value);

export const isManagerOnlyTab = (tab: HomeTab): boolean => MANAGER_ONLY_TABS.has(tab);

const activeTabs = new Map<string, HomeTab>();

const tabKey = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`;

export const getActiveTab = (workspaceId: string, userId: string, viewer: { isManager: boolean }): HomeTab => {
  const stored = activeTabs.get(tabKey(workspaceId, userId));
  if (!stored) return 'home';
  if (!viewer.isManager && isManagerOnlyTab(stored)) return 'home';
  return stored;
};

export const setActiveTab = (workspaceId: string, userId: string, tab: HomeTab): void => {
  activeTabs.set(tabKey(workspaceId, userId), tab);
};

/** Clears the process-wide map so one test's navigation cannot leak into another. */
export const resetHomeTabsForTests = (): void => {
  activeTabs.clear();
};
