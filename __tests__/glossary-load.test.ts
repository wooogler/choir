import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DATA = path.join(os.tmpdir(), 'choir-glossary-load-test');
process.env.CHOIR_DATA_DIR = DATA;

import { clearGlossaryCache, glossaryFileFor, loadAllGlossaries, loadGlossary } from '../services/glossary/load';

/**
 * The folder chain is the whole feature: a project's glossary overrides the
 * organization's, and nothing else does. These run against a real mirror
 * directory because the case-insensitive filename match and the mtime cache are
 * filesystem behaviour, and a mocked fs would be testing the mock.
 */

const WS = 'T-glossary';
const repoRoot = path.join(DATA, 'workspaces', WS, 'repo');

function write(relativePath: string, content: string): void {
  const target = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function glossary(rows: Array<[string, string, string]>): string {
  return ['| Term | Aka | Description |', '| --- | --- | --- |', ...rows.map((row) => `| ${row.join(' | ')} |`)].join(
    '\n',
  );
}

beforeEach(() => {
  fs.rmSync(path.join(DATA, 'workspaces', WS), { recursive: true, force: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  clearGlossaryCache();
});

describe('loadGlossary', () => {
  it('merges the chain from the document up to the root, nearest first', async () => {
    write(
      'GLOSSARY.md',
      glossary([
        ['CHOIR', '코이어', 'The organization-wide answer'],
        ['QMD', '큐엠디', 'The search index'],
      ]),
    );
    write('projects/GLOSSARY.md', glossary([['RAG', '래그', 'Retrieval-Augmented Generation']]));
    write('projects/alpha/GLOSSARY.md', glossary([['CHOIR', '콰이어', "Alpha's own answer"]]));

    const { entries, files } = await loadGlossary(WS, 'projects/alpha/2026-09-20-weekly.md');

    expect(files).toEqual(['projects/alpha/GLOSSARY.md', 'projects/GLOSSARY.md', 'GLOSSARY.md']);
    expect(entries.map((entry) => [entry.term, entry.description])).toEqual([
      ['CHOIR', "Alpha's own answer"],
      ['RAG', 'Retrieval-Augmented Generation'],
      ['QMD', 'The search index'],
    ]);
    // The nearest file wins the term, and it is credited with it.
    expect(entries[0].file).toBe('projects/alpha/GLOSSARY.md');
  });

  it('takes a folder path ending in a slash as the folder itself', async () => {
    write('meetings/GLOSSARY.md', glossary([['Weekly', '', 'The Monday sync']]));

    await expect(loadGlossary(WS, 'meetings/')).resolves.toMatchObject({ files: ['meetings/GLOSSARY.md'] });
    // Without the slash it is a document called `meetings`, whose folder is the root.
    await expect(loadGlossary(WS, 'meetings')).resolves.toMatchObject({ files: [] });
  });

  it('matches the file name without regard to case', async () => {
    write('projects/alpha/Glossary.md', glossary([['CHOIR', '코이어', 'Found anyway']]));

    const { files, entries } = await loadGlossary(WS, 'projects/alpha/notes.md');
    expect(files).toEqual(['projects/alpha/Glossary.md']);
    expect(entries).toHaveLength(1);
  });

  it('honours a workspace that renamed the file', async () => {
    write('TERMS.md', glossary([['CHOIR', '코이어', 'In a renamed glossary']]));

    await expect(loadGlossary(WS, 'notes.md')).resolves.toMatchObject({ files: [] });
    await expect(loadGlossary(WS, 'notes.md', { fileName: 'terms.md' })).resolves.toMatchObject({
      files: ['TERMS.md'],
    });
  });

  it('is empty when the repository has no glossary at all', async () => {
    write('notes.md', '# Notes\n');
    await expect(loadGlossary(WS, 'notes.md')).resolves.toEqual({ entries: [], files: [] });
  });

  it('re-reads a glossary that changed and reuses one that did not', async () => {
    write('GLOSSARY.md', glossary([['CHOIR', '코이어', 'Before']]));

    const first = await loadGlossary(WS, 'notes.md');
    expect(first.entries[0].description).toBe('Before');

    // A new mtime AND a new length: the cache key is both.
    const file = path.join(repoRoot, 'GLOSSARY.md');
    fs.writeFileSync(file, glossary([['CHOIR', '코이어', 'After the edit']]));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(file, future, future);

    const second = await loadGlossary(WS, 'notes.md');
    expect(second.entries[0].description).toBe('After the edit');

    // Unchanged file, served from the cache — verified by making the file
    // unreadable and asking again: a re-read would throw or come back empty.
    fs.chmodSync(file, 0o000);
    try {
      const third = await loadGlossary(WS, 'notes.md');
      expect(third.entries[0].description).toBe('After the edit');
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });
});

describe('loadAllGlossaries', () => {
  it('unions every glossary in the repository, with the root one last', async () => {
    write('GLOSSARY.md', glossary([['CHOIR', '코이어', 'The organization-wide answer']]));
    write('projects/alpha/GLOSSARY.md', glossary([['CHOIR', '콰이어', "Alpha's own answer"]]));
    write('meetings/GLOSSARY.md', glossary([['Weekly', '', 'The Monday sync']]));
    write('.choir/GLOSSARY.md', glossary([['Hidden', '', 'Machinery, not documentation']]));

    const { entries, files } = await loadAllGlossaries(WS);

    expect(files).toEqual(['projects/alpha/GLOSSARY.md', 'meetings/GLOSSARY.md', 'GLOSSARY.md']);
    expect(entries.map((entry) => entry.term)).toEqual(['CHOIR', 'Weekly']);
    // Deepest wins the duplicated term, as in the folder chain.
    expect(entries[0].description).toBe("Alpha's own answer");
    expect(entries.map((entry) => entry.term)).not.toContain('Hidden');
  });

  it('is empty for a workspace with no mirror yet', async () => {
    await expect(loadAllGlossaries('T-never-synced')).resolves.toEqual({ entries: [], files: [] });
  });
});

describe('glossaryFileFor', () => {
  it('names the nearest existing glossary walking up from the folder', async () => {
    write('GLOSSARY.md', glossary([['CHOIR', '코이어', 'Root']]));
    write('projects/alpha/GLOSSARY.md', glossary([['RAG', '', 'Alpha']]));

    await expect(glossaryFileFor(WS, 'projects/alpha')).resolves.toBe('projects/alpha/GLOSSARY.md');
    await expect(glossaryFileFor(WS, 'projects/alpha/')).resolves.toBe('projects/alpha/GLOSSARY.md');
    // No glossary in meetings/ or above it but the root's.
    await expect(glossaryFileFor(WS, 'meetings')).resolves.toBe('GLOSSARY.md');
    await expect(glossaryFileFor(WS, '')).resolves.toBe('GLOSSARY.md');
  });

  it('is null when there is nowhere to put a new term yet', async () => {
    write('meetings/2026-09-20.md', '# Weekly\n');
    await expect(glossaryFileFor(WS, 'meetings')).resolves.toBeNull();
  });
});
