import {
  PROJECT_FILE,
  normalizeProjectFolder,
  parseProjectSettings,
  serializeProjectSettings,
} from '../services/projects/schema';

/**
 * The validation standing between a browser's JSON and a commit in someone's
 * repository. What is tested here is the three ways that matters: a folder that
 * would escape the repository, a settings object that would be written back
 * wrong, and the defaults a half-filled dialog relies on.
 */

describe('normalizeProjectFolder', () => {
  it('keeps a repository-relative folder and strips the decoration', () => {
    expect(normalizeProjectFolder('projects/alpha')).toBe('projects/alpha');
    expect(normalizeProjectFolder('/projects/alpha/')).toBe('projects/alpha');
    expect(normalizeProjectFolder('  projects/./alpha  ')).toBe('projects/alpha');
  });

  it('refuses the repository root — the root is not a project', () => {
    expect(normalizeProjectFolder('')).toBeNull();
    expect(normalizeProjectFolder('/')).toBeNull();
    expect(normalizeProjectFolder('.')).toBeNull();
  });

  it('refuses traversal and the reserved folders', () => {
    expect(normalizeProjectFolder('../elsewhere')).toBeNull();
    expect(normalizeProjectFolder('projects/../../etc')).toBeNull();
    expect(normalizeProjectFolder('assets')).toBeNull();
    expect(normalizeProjectFolder('assets/images')).toBeNull();
    expect(normalizeProjectFolder('.choir')).toBeNull();
    expect(normalizeProjectFolder('projects/.choir')).toBeNull();
    expect(normalizeProjectFolder('projects\\alpha')).toBeNull();
    expect(normalizeProjectFolder(42 as unknown as string)).toBeNull();
  });
});

describe('parseProjectSettings', () => {
  it('fills every default from a name alone', () => {
    const parsed = parseProjectSettings({ name: 'Alpha' });
    if (!parsed.ok) throw new Error(parsed.message);

    expect(parsed.value).toEqual({
      version: 1,
      name: 'Alpha',
      description: '',
      channels: [],
      members: { source: 'channels', curated: [], aliases: {} },
      scope: { retrieval: 'boost', updates: 'folder' },
      meetingsFolder: 'meetings',
      glossary: 'GLOSSARY.md',
    });
  });

  it('accepts the shape the design document shows', () => {
    const parsed = parseProjectSettings({
      version: 1,
      name: 'Alpha',
      description: 'Experiment platform',
      channels: ['C0AB12CD3', 'G0EF45GH6'],
      members: {
        source: 'curated',
        curated: ['U01AAA', 'W02BBB'],
        aliases: { U01AAA: ['Sangwook', ' Speaker 1 '] },
      },
      scope: { retrieval: 'exclusive', updates: 'workspace' },
      meetingsFolder: 'notes/weekly',
      glossary: 'terms.MD',
    });
    if (!parsed.ok) throw new Error(parsed.message);

    expect(parsed.value.channels).toEqual(['C0AB12CD3', 'G0EF45GH6']);
    expect(parsed.value.members.aliases).toEqual({ U01AAA: ['Sangwook', 'Speaker 1'] });
    expect(parsed.value.scope).toEqual({ retrieval: 'exclusive', updates: 'workspace' });
    expect(parsed.value.meetingsFolder).toBe('notes/weekly');
    // The extension is lowercased, because the mirror walk matches `.md`.
    expect(parsed.value.glossary).toBe('terms.md');
  });

  it('refuses an unknown key rather than dropping it', () => {
    const parsed = parseProjectSettings({ name: 'Alpha', retrievalScope: 'boost' });
    expect(parsed).toEqual({ ok: false, message: 'retrievalScope is not a known setting' });

    const nested = parseProjectSettings({ name: 'Alpha', scope: { retrieval: 'boost', boost: 2 } });
    expect(nested.ok).toBe(false);
  });

  it('refuses malformed Slack IDs', () => {
    expect(parseProjectSettings({ name: 'A', channels: ['C0AB12CD3', 'nope'] })).toEqual({
      ok: false,
      message: 'channels[1] is not a Slack channel ID',
    });
    expect(parseProjectSettings({ name: 'A', members: { curated: ['X1'] } })).toEqual({
      ok: false,
      message: 'members.curated[0] is not a Slack user ID',
    });
    expect(parseProjectSettings({ name: 'A', members: { aliases: { nobody: ['x'] } } }).ok).toBe(false);
  });

  it('refuses a name-less project, a bad enum and a version it cannot write back', () => {
    expect(parseProjectSettings({ name: '  ' })).toEqual({ ok: false, message: 'name is required' });
    expect(parseProjectSettings({ name: 'A', scope: { retrieval: 'everything' } }).ok).toBe(false);
    expect(parseProjectSettings({ name: 'A', members: { source: 'nobody' } }).ok).toBe(false);
    expect(parseProjectSettings({ version: 2, name: 'A' })).toEqual({ ok: false, message: 'unsupported version 2' });
    expect(parseProjectSettings('nope').ok).toBe(false);
  });

  it('refuses a meetings folder or glossary that would leave the project', () => {
    expect(parseProjectSettings({ name: 'A', meetingsFolder: '../meetings' }).ok).toBe(false);
    expect(parseProjectSettings({ name: 'A', glossary: '../GLOSSARY.md' }).ok).toBe(false);
    expect(parseProjectSettings({ name: 'A', glossary: 'terms.txt' }).ok).toBe(false);
  });

  it('drops a repeated channel instead of committing it twice', () => {
    const parsed = parseProjectSettings({ name: 'A', channels: ['C1AB', 'C1AB'] });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.value.channels).toEqual(['C1AB']);
  });
});

describe('serializeProjectSettings', () => {
  it('writes a fixed key order so one changed channel is a one-line diff', () => {
    const parsed = parseProjectSettings({
      glossary: 'GLOSSARY.md',
      channels: ['C0ZZ', 'C0AA'],
      name: 'Alpha',
      members: { aliases: { U02B: ['b'], U01A: ['a'] }, curated: ['U02B', 'U01A'] },
    });
    if (!parsed.ok) throw new Error(parsed.message);

    const text = serializeProjectSettings(parsed.value);
    expect(text.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual([
      'version',
      'name',
      'description',
      'channels',
      'members',
      'scope',
      'meetingsFolder',
      'glossary',
    ]);
    expect(JSON.parse(text).channels).toEqual(['C0AA', 'C0ZZ']);
    expect(Object.keys(JSON.parse(text).members.aliases)).toEqual(['U01A', 'U02B']);
    // Round-trips: what is written back parses to what was written.
    expect(parseProjectSettings(JSON.parse(text))).toEqual({ ok: true, value: parsed.value });
  });
});

it('keeps the metadata under the reserved folder name', () => {
  expect(PROJECT_FILE).toBe('.choir/project.json');
});
