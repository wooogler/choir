import { meetingTargetPath, parseMeetingMeta } from 'services/import/sources/meeting/meta';

/**
 * These fields are the whole reason "회의록 만들기" is its own dialog: they come
 * from a person, and the model never gets a vote (결정 2). So the checks here are
 * about what a person can mistype — and about the two paths a document may never
 * be written to, which this shares with every other write in the repository.
 */

const VALID = {
  title: 'Weekly sync',
  date: '2026-09-20',
  folder: 'meetings',
  fileName: '2026-09-20-weekly-sync.md',
  participants: ['Sangwook Lee', 'Minji Kim'],
  context: 'CHOIR weekly',
  format: 'notes',
};

function parse(overrides: Record<string, unknown> = {}) {
  return parseMeetingMeta({ ...VALID, ...overrides });
}

function messageOf(result: ReturnType<typeof parseMeetingMeta>): string {
  return result.ok ? '' : result.message;
}

describe('parseMeetingMeta', () => {
  it('accepts a filled-in dialog', () => {
    const result = parse();
    expect(result).toEqual({
      ok: true,
      value: {
        title: 'Weekly sync',
        date: '2026-09-20',
        folder: 'meetings',
        fileName: '2026-09-20-weekly-sync.md',
        participants: ['Sangwook Lee', 'Minji Kim'],
        context: 'CHOIR weekly',
        format: 'notes',
      },
    });
  });

  it('refuses a missing title, and one too long to be a heading', () => {
    expect(messageOf(parse({ title: '   ' }))).toMatch(/title/i);
    expect(messageOf(parse({ title: 'x'.repeat(201) }))).toMatch(/200/);
  });

  it('insists on a real calendar date', () => {
    expect(parse({ date: '2026-09-20' }).ok).toBe(true);
    for (const date of ['20 Sep 2026', '2026-9-2', '2026-02-31', '']) {
      expect([date, parse({ date }).ok]).toEqual([date, false]);
    }
  });

  it('normalizes the folder the several ways a dialog may send it', () => {
    for (const folder of ['meetings', '/meetings', 'meetings/', '/meetings/', './meetings']) {
      const result = parse({ folder });
      expect([folder, result.ok && result.value.folder]).toEqual([folder, 'meetings']);
    }

    const root = parse({ folder: '' });
    expect(root.ok && root.value.folder).toBe('');
  });

  it('refuses a folder that climbs out of the repository or is reserved', () => {
    for (const folder of ['../secrets', 'meetings/../..', 'assets', '.choir', '.choir/context']) {
      expect([folder, parse({ folder }).ok]).toEqual([folder, false]);
    }
  });

  it('insists the file name is a markdown basename', () => {
    expect(messageOf(parse({ fileName: 'notes' }))).toMatch(/\.md/);
    expect(messageOf(parse({ fileName: 'sub/notes.md' }))).toMatch(/folder/i);
    expect(messageOf(parse({ fileName: '' }))).toMatch(/name/i);
    expect(parse({ fileName: 'Weekly_Sync_0920.MD' }).ok).toBe(true);
  });

  it('trims and de-duplicates participants, and caps the list', () => {
    const result = parse({ participants: ['  Minji Kim ', 'Minji  Kim', 'minji kim', '', 'Junho Park'] });
    expect(result.ok && result.value.participants).toEqual(['Minji Kim', 'Junho Park']);

    expect(parse({ participants: Array.from({ length: 51 }, (_, i) => `Person ${i}`) }).ok).toBe(false);
    expect(parse({ participants: 'Minji Kim' }).ok).toBe(false);
    expect(parse({ participants: undefined }).ok).toBe(true);
  });

  it('keeps the context line optional and bounded', () => {
    const none = parse({ context: '   ' });
    expect(none.ok && none.value.context).toBeUndefined();
    expect(parse({ context: 'x'.repeat(501) }).ok).toBe(false);
  });

  it('only knows the two formats the dialog offers', () => {
    expect(parse({ format: 'transcript' }).ok).toBe(true);
    expect(parse({ format: 'summary' }).ok).toBe(false);
    expect(parse({ format: undefined }).ok).toBe(false);
  });

  it('refuses something that is not an object at all', () => {
    for (const value of [undefined, null, 'meta', ['meta'], 42]) {
      expect(parseMeetingMeta(value).ok).toBe(false);
    }
  });
});

describe('meetingTargetPath', () => {
  it('joins the folder and the file, and lowercases the extension', () => {
    const result = parse({ fileName: 'Weekly.MD' });
    expect(result.ok && meetingTargetPath(result.value)).toBe('meetings/Weekly.md');
  });

  it('puts a root-folder note at the root', () => {
    const result = parse({ folder: '' });
    expect(result.ok && meetingTargetPath(result.value)).toBe('2026-09-20-weekly-sync.md');
  });

  it('keeps a nested folder', () => {
    const result = parse({ folder: 'projects/alpha/meetings' });
    expect(result.ok && meetingTargetPath(result.value)).toBe('projects/alpha/meetings/2026-09-20-weekly-sync.md');
  });
});
