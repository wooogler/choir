// Which App Home tab a person lands on, and what the tab-bar buttons do.
//
// Two halves of one gate are under test. `home-tabs.ts` remembers a choice and
// refuses to hand back a manager-only tab to someone who is no longer a manager;
// the `home_tab:` handler is what stops a replayed block action from parking a
// member on Advanced in the first place. Both matter, because hiding the bar is
// layout, not enforcement.

const logAppHomeButtonClick = jest.fn(async () => undefined);
const refreshAppHome = jest.fn(async () => undefined);
const isManager = jest.fn(async () => true);
const isWorkspaceOwner = jest.fn(async () => false);

jest.mock('services/common/interaction-tracker', () => ({
  logAppHomeButtonClick: (...args: unknown[]) => logAppHomeButtonClick(...(args as [])),
  logAppHomeModalSubmit: jest.fn(async () => undefined),
}));

jest.mock('services/slack', () => ({
  getWorkspaceId: jest.fn(async () => 'T1'),
  isManager: (...args: unknown[]) => isManager(...(args as [])),
  isWorkspaceOwner: (...args: unknown[]) => isWorkspaceOwner(...(args as [])),
}));

jest.mock('../listeners/features/app-home/refresh', () => ({
  refreshAppHome: (...args: unknown[]) => refreshAppHome(...(args as [])),
  refreshAppHomeSoon: jest.fn(),
}));

import {
  HOME_TABS,
  getActiveTab,
  isHomeTab,
  isManagerOnlyTab,
  resetHomeTabsForTests,
  setActiveTab,
} from '../listeners/features/app-home/home-tabs';
import { registerTabHandlers } from '../listeners/features/app-home/management/tab-handlers';

const manager = { isManager: true };
const member = { isManager: false };

beforeEach(() => {
  jest.clearAllMocks();
  resetHomeTabsForTests();
  isManager.mockResolvedValue(true);
  isWorkspaceOwner.mockResolvedValue(false);
});

describe('home-tabs', () => {
  it('lists the four tabs in display order', () => {
    expect(HOME_TABS).toEqual(['home', 'documents', 'team', 'advanced']);
    expect(HOME_TABS.filter(isManagerOnlyTab)).toEqual(['documents', 'team', 'advanced']);
  });

  it('starts everyone on Home', () => {
    expect(getActiveTab('T1', 'U1', manager)).toBe('home');
    expect(getActiveTab('T1', 'U1', member)).toBe('home');
  });

  it('remembers a choice per workspace and user', () => {
    setActiveTab('T1', 'U1', 'team');

    expect(getActiveTab('T1', 'U1', manager)).toBe('team');
    expect(getActiveTab('T1', 'U2', manager)).toBe('home');
    expect(getActiveTab('T2', 'U1', manager)).toBe('home');
  });

  it('sends a demoted manager back to Home', () => {
    setActiveTab('T1', 'U1', 'advanced');

    expect(getActiveTab('T1', 'U1', member)).toBe('home');
    // Home itself is never gated.
    setActiveTab('T1', 'U1', 'home');
    expect(getActiveTab('T1', 'U1', member)).toBe('home');
  });

  it('recognises only the four tab names', () => {
    expect(isHomeTab('documents')).toBe(true);
    expect(isHomeTab('settings')).toBe(false);
    expect(isHomeTab(undefined)).toBe(false);
    expect(isHomeTab(3)).toBe(false);
  });
});

type Handler = (args: any) => Promise<void>;

/** Registers the tab listener and returns it along with the pattern it matched on. */
const collectTabHandler = (): { pattern: RegExp; handler: Handler } => {
  let captured: { pattern: RegExp; handler: Handler } | undefined;
  registerTabHandlers({
    action: (pattern: RegExp, handler: Handler) => {
      captured = { pattern, handler };
    },
  } as any);
  if (!captured) throw new Error('no tab handler registered');
  return captured;
};

const invoke = async (handler: Handler, actionId: string, userId = 'U1') => {
  const ack = jest.fn(async () => undefined);
  await handler({
    ack,
    action: { action_id: actionId },
    body: { user: { id: userId } },
    client: {},
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return ack;
};

describe('home_tab: handler', () => {
  it('matches every tab button and nothing else', () => {
    const { pattern } = collectTabHandler();

    for (const tab of HOME_TABS) expect(pattern.test(`home_tab:${tab}`)).toBe(true);
    expect(pattern.test('toggle_logging')).toBe(false);
    expect(pattern.test('open_home_tab:team')).toBe(false);
  });

  it('acks, stores the tab and republishes immediately', async () => {
    const { handler } = collectTabHandler();

    const ack = await invoke(handler, 'home_tab:advanced');

    expect(ack).toHaveBeenCalled();
    expect(getActiveTab('T1', 'U1', manager)).toBe('advanced');
    expect(refreshAppHome).toHaveBeenCalledWith(expect.objectContaining({ userId: 'U1', reason: 'tab switch' }));
    expect(logAppHomeButtonClick).toHaveBeenCalled();
  });

  it('stores Home when a non-manager asks for a manager tab', async () => {
    isManager.mockResolvedValue(false);
    const { handler } = collectTabHandler();

    await invoke(handler, 'home_tab:team', 'U9');

    expect(getActiveTab('T1', 'U9', manager)).toBe('home');
    expect(refreshAppHome).toHaveBeenCalledTimes(1);
  });

  it('lets the workspace owner through even when they are not a listed manager', async () => {
    isManager.mockResolvedValue(false);
    isWorkspaceOwner.mockResolvedValue(true);
    const { handler } = collectTabHandler();

    await invoke(handler, 'home_tab:documents');

    expect(getActiveTab('T1', 'U1', manager)).toBe('documents');
  });

  it('falls back to Home for an action_id naming no tab we know', async () => {
    const { handler } = collectTabHandler();
    setActiveTab('T1', 'U1', 'team');

    await invoke(handler, 'home_tab:billing');

    expect(getActiveTab('T1', 'U1', manager)).toBe('home');
  });
});
