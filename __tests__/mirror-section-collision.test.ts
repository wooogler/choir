import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DATA = path.join(os.tmpdir(), 'choir-mirror-section-test');
process.env.CHOIR_DATA_DIR = DATA;

import { WorkspaceMirrorService } from '../services/workspace/mirror-service';

const ws = 'T-sections';
const mirror = WorkspaceMirrorService.getInstance();

const wsRoot = () => path.join(DATA, 'workspaces', ws);
const repoRoot = () => path.join(wsRoot(), 'repo');
const sectionsRoot = () => path.join(wsRoot(), 'sections');

beforeAll(() => {
  fs.rmSync(wsRoot(), { recursive: true, force: true });
  fs.mkdirSync(path.join(repoRoot(), 'x'), { recursive: true });
  // A FILE named x.md and a DIRECTORY named x/ containing foo.md — the collision case.
  fs.writeFileSync(path.join(repoRoot(), 'x.md'), '# X file\n\nContent of the x.md file.\n');
  fs.writeFileSync(path.join(repoRoot(), 'x', 'foo.md'), '# Foo\n\nContent of x/foo.md.\n');
});

describe('section files: the file x.md and the directory x/ do not collide', () => {
  it('builds disjoint section directories for x.md and x/foo.md', async () => {
    await mirror.populateSectionsIfEmpty(ws);

    expect(fs.existsSync(path.join(sectionsRoot(), 'x.md'))).toBe(true);
    expect(fs.existsSync(path.join(sectionsRoot(), 'x', 'foo.md'))).toBe(true);
    expect(fs.readdirSync(path.join(sectionsRoot(), 'x.md')).some((f) => f.endsWith('.md'))).toBe(true);
    expect(fs.readdirSync(path.join(sectionsRoot(), 'x', 'foo.md')).some((f) => f.endsWith('.md'))).toBe(true);
  });

  it('re-writing x.md does NOT wipe the sections of x/foo.md (regression)', async () => {
    await mirror.populateSectionsIfEmpty(ws);
    const fooBefore = fs.readdirSync(path.join(sectionsRoot(), 'x', 'foo.md')).sort();

    await mirror.writeMarkdownFile(ws, 'x.md', '# X file\n\nUpdated content of x.md.\n');

    expect(fs.existsSync(path.join(sectionsRoot(), 'x', 'foo.md'))).toBe(true);
    const fooAfter = fs.readdirSync(path.join(sectionsRoot(), 'x', 'foo.md')).sort();
    expect(fooAfter).toEqual(fooBefore);
  });

  it('stamps the section format marker', () => {
    expect(fs.existsSync(path.join(sectionsRoot(), '.format'))).toBe(true);
    expect(fs.readFileSync(path.join(sectionsRoot(), '.format'), 'utf-8').trim()).toBe('2');
  });

  it('wipes stale-format section dirs and restamps on a full rebuild', async () => {
    // Simulate an old on-disk layout: downgrade the marker and drop a leftover
    // directory that the current format would never produce.
    fs.writeFileSync(path.join(sectionsRoot(), '.format'), '1');
    fs.mkdirSync(path.join(sectionsRoot(), 'stale-old-layout'), { recursive: true });
    fs.writeFileSync(path.join(sectionsRoot(), 'stale-old-layout', '0.md'), 'stale');

    await mirror.writeMarkdownFiles(ws, [{ path: 'x.md', content: '# X file\n\nRebuilt content.\n' }]);

    expect(fs.existsSync(path.join(sectionsRoot(), 'stale-old-layout'))).toBe(false);
    expect(fs.readFileSync(path.join(sectionsRoot(), '.format'), 'utf-8').trim()).toBe('2');
    expect(fs.existsSync(path.join(sectionsRoot(), 'x.md'))).toBe(true);
  });
});
