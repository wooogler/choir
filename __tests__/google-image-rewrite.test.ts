import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyImageToken } from 'services/docs-editor/image-token';
import { rewriteImagesForDrive } from 'services/google/image-rewrite';

describe('rewriting images for Drive import', () => {
  let tempDir: string;
  let repoRoot: string;

  const writeAsset = (relPath: string) => {
    const absolute = path.join(repoRoot, relPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'not-really-a-png');
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-gdocs-img-'));
    process.env.CHOIR_DATA_DIR = tempDir;
    process.env.DOCS_BASE_URL = 'https://choir.example.com';
    repoRoot = path.join(tempDir, 'workspaces', 'T1', 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
    Reflect.deleteProperty(process.env, 'DOCS_BASE_URL');
  });

  it('turns a repo-relative image into a public URL Drive can fetch', () => {
    writeAsset('docs/images/diagram.png');

    const output = rewriteImagesForDrive('T1', 'docs/guide.md', '![Diagram](images/diagram.png)');

    expect(output).toMatch(
      /^!\[Diagram\]\(https:\/\/choir\.example\.com\/api\/docs\/T1\/docs\/images\/diagram\.png\?token=/,
    );
  });

  it('signs the token for the exact image path so the route stays closed', () => {
    writeAsset('docs/images/diagram.png');

    const output = rewriteImagesForDrive('T1', 'docs/guide.md', '![d](images/diagram.png)');
    const token = decodeURIComponent(/token=([^)]+)/.exec(output)?.[1] ?? '');

    expect(verifyImageToken(token, 'T1', 'docs/images/diagram.png')).toBe(true);
    // A token minted for one image must not open another.
    expect(verifyImageToken(token, 'T1', 'docs/images/other.png')).toBe(false);
    expect(verifyImageToken(token, 'T2', 'docs/images/diagram.png')).toBe(false);
  });

  it('leaves remote images untouched', () => {
    const markdown = '![Logo](https://example.com/logo.png)';
    expect(rewriteImagesForDrive('T1', 'docs/guide.md', markdown)).toBe(markdown);
  });

  it('leaves data URLs untouched', () => {
    const markdown = '![Inline](data:image/png;base64,AAAA)';
    expect(rewriteImagesForDrive('T1', 'docs/guide.md', markdown)).toBe(markdown);
  });

  it('drops an image whose file is not in the mirror', () => {
    // Drive fetches during conversion, so an unresolvable src becomes a broken
    // image in a document people are meant to read.
    expect(rewriteImagesForDrive('T1', 'docs/guide.md', 'before ![Missing](images/gone.png) after')).toBe(
      'before  after',
    );
  });

  it('drops an image that points outside the repository', () => {
    writeAsset('docs/images/diagram.png');
    fs.writeFileSync(path.join(tempDir, 'secret.png'), 'secret');

    expect(rewriteImagesForDrive('T1', 'docs/guide.md', '![Escape](../../../secret.png)')).toBe('');
  });

  it('drops a non-image file even when it exists', () => {
    writeAsset('docs/notes.txt');
    expect(rewriteImagesForDrive('T1', 'docs/guide.md', '![Notes](notes.txt)')).toBe('');
  });

  it('drops local images when there is no public base URL to serve them from', () => {
    writeAsset('docs/images/diagram.png');
    Reflect.deleteProperty(process.env, 'DOCS_BASE_URL');

    expect(rewriteImagesForDrive('T1', 'docs/guide.md', '![d](images/diagram.png)')).toBe('');
  });

  it('resolves a root-relative src against the repository root', () => {
    writeAsset('assets/logo.png');

    const output = rewriteImagesForDrive('T1', 'docs/deep/guide.md', '![Logo](/assets/logo.png)');

    expect(output).toContain('/api/docs/T1/assets/logo.png?token=');
  });

  it('rewrites every image in a document', () => {
    writeAsset('docs/a.png');
    writeAsset('docs/b.png');

    const output = rewriteImagesForDrive('T1', 'docs/guide.md', '![A](a.png)\n\n![B](b.png)');

    expect(output.match(/token=/g)).toHaveLength(2);
  });

  it('leaves surrounding markdown alone', () => {
    const markdown = '# Title\n\nSome `code` and a [link](https://example.com).\n';
    expect(rewriteImagesForDrive('T1', 'docs/guide.md', markdown)).toBe(markdown);
  });
});
