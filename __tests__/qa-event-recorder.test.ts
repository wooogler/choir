import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock the LLM paraphrase so tests never call OpenAI. Gating tests never reach it;
// the happy-path test controls its return value.
jest.mock('services/dashboard/paraphrase', () => ({ paraphraseQuestion: jest.fn() }));

import { getAnonymizationMapping } from 'services/common/name-cache';
import { paraphraseQuestion } from 'services/dashboard/paraphrase';
import { recordQaEvent } from 'services/dashboard/qa-event-recorder';
import { countQaEvents, getQaEvents } from 'services/dashboard/qa-event-store';
import { closeDatabase, getDatabase } from 'services/db/connection';
import { clearWorkspaceIdCache } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';

const WS = 'T-dash';
const USER = 'U-student';
const mockParaphrase = paraphraseQuestion as jest.Mock;

async function seedConfig(overrides: Partial<Record<string, unknown>> = {}) {
  await new WorkspaceStore().saveWorkspaceConfig({
    workspaceId: WS,
    managers: ['U-mgr'],
    choirUsers: ['U-mgr', USER],
    organizationName: WS,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any);
}

const params = (extra: Partial<Parameters<typeof recordQaEvent>[0]> = {}) => ({
  workspaceId: WS,
  userId: USER,
  question: "I'm a second author, can I get travel funding?",
  canAnswer: true,
  searchResults: 2,
  channelType: 'im',
  relevantDocs: [{ metadata: { fileName: '06_Conferences.md', sectionId: 's1', headingPath: 'Funding' } }],
  ...extra,
});

describe('recordQaEvent', () => {
  let tempDir: string;

  beforeEach(() => {
    closeDatabase();
    clearWorkspaceIdCache();
    mockParaphrase.mockReset();
    mockParaphrase.mockResolvedValue('Is travel funding available for second authors?');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-qa-rec-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
    process.env.CHOIR_DATA_DIR = tempDir;
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    Reflect.deleteProperty(process.env, 'CHOIR_DB_KEY_FILE');
    Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
  });

  it('records a scrubbed event for an enabled workspace + registered user', async () => {
    await seedConfig();
    await recordQaEvent(params());

    const events = getQaEvents(WS);
    expect(events).toHaveLength(1);
    expect(events[0].paraphrase).toBe('Is travel funding available for second authors?');
    expect(events[0].channelType).toBe('dm'); // 'im' normalized
    expect(events[0].canAnswer).toBe(true);
    expect(events[0].userHash).toMatch(/^[0-9a-f]{64}$/); // HMAC-SHA256 hex, not the raw userId
    expect(events[0].userHash).not.toContain(USER);
  });

  it('never stores the raw question text', async () => {
    await seedConfig();
    await recordQaEvent(params({ question: 'my super identifying raw question about xyz' }));
    expect(getQaEvents(WS)[0].paraphrase).not.toContain('super identifying raw');
  });

  it('skips users who are not registered CHOIR users', async () => {
    await seedConfig({ choirUsers: ['U-mgr'] }); // USER not included
    await recordQaEvent(params());
    expect(countQaEvents(WS)).toBe(0);
    expect(mockParaphrase).not.toHaveBeenCalled();
  });

  it('skips when the workspace has the dashboard disabled', async () => {
    await seedConfig({ dashboardEnabled: false });
    await recordQaEvent(params());
    expect(countQaEvents(WS)).toBe(0);
  });

  it('skips a user who opted out', async () => {
    await seedConfig({ dashboardOptOut: [USER] });
    await recordQaEvent(params());
    expect(countQaEvents(WS)).toBe(0);
  });

  it('skips (stores nothing) when paraphrasing fails', async () => {
    await seedConfig();
    mockParaphrase.mockResolvedValue(null);
    await recordQaEvent(params());
    expect(countQaEvents(WS)).toBe(0);
  });

  it('hashes the same user stably and different users distinctly', async () => {
    await seedConfig({ choirUsers: ['U-mgr', USER, 'U-other'] });
    await recordQaEvent(params()); // USER
    await recordQaEvent(params()); // USER again
    await recordQaEvent(params({ userId: 'U-other' })); // different user

    const distinctHashes = new Set(getQaEvents(WS).map((e) => e.userHash));
    expect(distinctHashes.size).toBe(2); // 3 events, 2 users -> 2 distinct hashes (USER stable)
  });

  it('anonymizes the question BEFORE paraphrasing (real name never reaches the paraphraser)', async () => {
    await seedConfig();
    // A real name that anonymizeText will mask to a pseudonym for this workspace.
    getAnonymizationMapping(USER, 'Alice Student', undefined, WS);

    await recordQaEvent(params({ question: 'Can I, Alice, get travel funding?' }));

    expect(mockParaphrase).toHaveBeenCalledTimes(1);
    const [passedText, passedWorkspaceId] = mockParaphrase.mock.calls[0];
    expect(passedText).not.toContain('Alice'); // masked before it reaches the paraphraser
    expect(passedWorkspaceId).toBe(WS); // workspaceId forwarded for key resolution
  });

  it.each([
    ['group', 'private'],
    ['mpim', 'private'],
    ['channel', 'public'],
    [undefined, 'public'],
  ])('normalizes channelType %s -> %s', async (raw, expected) => {
    await seedConfig();
    await recordQaEvent(params({ channelType: raw as string | undefined }));
    expect(getQaEvents(WS)[0].channelType).toBe(expected);
  });

  it('preserves a provided timestamp and derives its ISO week (backfill path)', async () => {
    await seedConfig();
    const at = Date.UTC(2026, 0, 1); // 2026-W01 per the iso-week fixtures
    await recordQaEvent(params({ at }));

    const event = getQaEvents(WS)[0];
    expect(event.createdAt).toBe(at);
    expect(event.isoWeek).toBe('2026-W01');
  });

  it('hashes the same userId differently across workspaces (per-workspace salt)', async () => {
    await seedConfig();
    await new WorkspaceStore().saveWorkspaceConfig({
      workspaceId: 'T-two',
      managers: ['U-mgr'],
      choirUsers: ['U-mgr', USER],
      organizationName: 'T-two',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    await recordQaEvent(params()); // WS
    await recordQaEvent(params({ workspaceId: 'T-two' }));

    expect(getQaEvents(WS)[0].userHash).not.toBe(getQaEvents('T-two')[0].userHash);
  });

  it('stores only chunks with a fileName and skips docs lacking metadata', async () => {
    await seedConfig();
    await recordQaEvent(
      params({
        relevantDocs: [
          { metadata: { fileName: 'A.md', sectionId: 's', headingPath: 'H' } },
          { metadata: {} }, // no fileName -> skipped
          { pageContent: 'x' }, // no metadata -> skipped
        ],
      }),
    );

    const id = getQaEvents(WS)[0].id;
    const chunks = getDatabase()
      .prepare(
        'SELECT file_name AS fileName, section_id AS sectionId, heading_path AS headingPath FROM qa_event_chunks WHERE event_id = ?',
      )
      .all(id);
    expect(chunks).toEqual([{ fileName: 'A.md', sectionId: 's', headingPath: 'H' }]);
  });
});
