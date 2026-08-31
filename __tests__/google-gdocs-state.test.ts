import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  contentHash,
  getAllDocStates,
  getDocState,
  mutateDocState,
  readBaseline,
  removeDocState,
  writeBaseline,
} from 'services/google/gdocs-state';
import type { GdocsDocState } from 'services/google/types';

const state = (overrides: Partial<GdocsDocState> = {}): GdocsDocState => ({
  status: 'synced',
  updatedAt: new Date().toISOString(),
  ...overrides,
});

describe('Google Docs replica sync state', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-gdocs-state-'));
    process.env.CHOIR_DATA_DIR = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
  });

  it('returns null for a document that has never synced', async () => {
    expect(await getDocState('T1', 'docs/a.md')).toBeNull();
    expect(await getAllDocStates('T1')).toEqual({});
  });

  it('persists and reads back a document state', async () => {
    await mutateDocState('T1', 'docs/a.md', () =>
      state({ status: 'synced', lastPushedVersion: '6', lastPushedContentHash: 'abc' }),
    );

    const stored = await getDocState('T1', 'docs/a.md');
    expect(stored?.status).toBe('synced');
    expect(stored?.lastPushedVersion).toBe('6');
    expect(stored?.lastPushedContentHash).toBe('abc');
  });

  it('passes the current state to the mutator', async () => {
    await mutateDocState('T1', 'docs/a.md', () => state({ lastPushedVersion: '1' }));

    const seen: Array<GdocsDocState | null> = [];
    await mutateDocState('T1', 'docs/a.md', (current) => {
      seen.push(current);
      return state({ ...current, status: 'drifted', driftDetectedAt: 'now' });
    });

    expect(seen[0]?.lastPushedVersion).toBe('1');
    expect((await getDocState('T1', 'docs/a.md'))?.status).toBe('drifted');
  });

  it('keeps concurrent updates to different documents in the same workspace', async () => {
    // Both documents live in one JSON file; without serialization the second
    // write would be built on a stale read and drop the first.
    await Promise.all([
      mutateDocState('T1', 'docs/a.md', () => state({ lastPushedVersion: 'a' })),
      mutateDocState('T1', 'docs/b.md', () => state({ lastPushedVersion: 'b' })),
      mutateDocState('T1', 'docs/c.md', () => state({ lastPushedVersion: 'c' })),
    ]);

    const all = await getAllDocStates('T1');
    expect(Object.keys(all).sort()).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md']);
    expect(all['docs/a.md'].lastPushedVersion).toBe('a');
    expect(all['docs/b.md'].lastPushedVersion).toBe('b');
    expect(all['docs/c.md'].lastPushedVersion).toBe('c');
  });

  it('isolates workspaces from each other', async () => {
    await mutateDocState('T1', 'docs/a.md', () => state({ lastPushedVersion: 'one' }));
    await mutateDocState('T2', 'docs/a.md', () => state({ lastPushedVersion: 'two' }));

    expect((await getDocState('T1', 'docs/a.md'))?.lastPushedVersion).toBe('one');
    expect((await getDocState('T2', 'docs/a.md'))?.lastPushedVersion).toBe('two');
  });

  it('removes a document state and its baseline together', async () => {
    await mutateDocState('T1', 'docs/a.md', () => state());
    await writeBaseline('T1', 'docs/a.md', '# baseline');

    await removeDocState('T1', 'docs/a.md');

    expect(await getDocState('T1', 'docs/a.md')).toBeNull();
    // A stale baseline would be compared against a re-linked document later.
    expect(await readBaseline('T1', 'docs/a.md')).toBeNull();
  });

  it('round-trips a baseline including content that is awkward in a path', async () => {
    const markdown = '# 제목\n\n본문 with `code` and | pipes |\n';
    await writeBaseline('T1', 'docs/한글 폴더/a b.md', markdown);

    expect(await readBaseline('T1', 'docs/한글 폴더/a b.md')).toBe(markdown);
  });

  it('reports a missing baseline as null rather than empty', async () => {
    // The caller must be able to tell "no baseline" from "baseline of an empty
    // document": the first means drift cannot be measured at all.
    expect(await readBaseline('T1', 'docs/never-pushed.md')).toBeNull();
  });

  it('survives a corrupt sync file without losing the workspace', async () => {
    await mutateDocState('T1', 'docs/a.md', () => state());
    const filePath = path.join(tempDir, 'workspaces', 'T1', 'state', 'gdocs-sync.json');
    fs.writeFileSync(filePath, '{ not json', 'utf-8');

    expect(await getAllDocStates('T1')).toEqual({});
    await expect(mutateDocState('T1', 'docs/a.md', () => state({ status: 'drifted' }))).resolves.toBeTruthy();
    expect((await getDocState('T1', 'docs/a.md'))?.status).toBe('drifted');
  });

  it('rejects a workspace id that would escape the data directory', async () => {
    await expect(getDocState('../evil', 'docs/a.md')).rejects.toThrow('Invalid workspaceId');
  });

  it('hashes content stably and distinguishes changes', () => {
    expect(contentHash('# a')).toBe(contentHash('# a'));
    expect(contentHash('# a')).not.toBe(contentHash('# b'));
  });
});

describe('empty baselines versus missing ones', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-gdocs-empty-'));
    process.env.CHOIR_DATA_DIR = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
  });

  it('keeps an empty baseline distinct from a missing one', async () => {
    // An empty Google Doc exports to zero bytes (measured in the P0 spike), so a
    // stored empty baseline is a real measurement — a human deleted everything —
    // while a missing file means drift cannot be measured at all.
    await writeBaseline('T1', 'docs/emptied.md', '');

    expect(await readBaseline('T1', 'docs/emptied.md')).toBe('');
    expect(await readBaseline('T1', 'docs/never-pushed.md')).toBeNull();
  });
});
