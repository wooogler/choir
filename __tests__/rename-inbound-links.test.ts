/**
 * Rename does not rewrite links, so the number it reports is the whole warning a
 * manager gets before breaking them. Both directions matter: a form this misses
 * understates the damage, and a false match sends someone hunting for a link
 * nobody wrote.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { countInboundLinks, linkedDocumentPaths } from '../services/docs-editor/inbound-links';

describe('linkedDocumentPaths', () => {
  it('reads an inline link, relative to the folder the linking document sits in', () => {
    expect(linkedDocumentPaths('See [the policy](onboarding.md).', 'policy/index.md')).toEqual([
      'policy/onboarding.md',
    ]);
    expect(linkedDocumentPaths('See [it](./onboarding.md).', 'policy/index.md')).toEqual(['policy/onboarding.md']);
    expect(linkedDocumentPaths('See [it](../README.md).', 'policy/index.md')).toEqual(['README.md']);
    expect(linkedDocumentPaths('See [it](../guides/setup.md).', 'policy/index.md')).toEqual(['guides/setup.md']);
  });

  it('treats a leading slash as repository-root-relative, the form the viewer writes', () => {
    expect(linkedDocumentPaths('[x](/policy/onboarding.md)', 'deep/nested/doc.md')).toEqual(['policy/onboarding.md']);
  });

  it('reads an angle-bracket destination, including one with spaces in it', () => {
    expect(linkedDocumentPaths('[x](<policy/team notes.md>)', 'README.md')).toEqual(['policy/team notes.md']);
  });

  it('reads a reference-style definition, with or without a title', () => {
    expect(linkedDocumentPaths('[policy]: policy/onboarding.md', 'README.md')).toEqual(['policy/onboarding.md']);
    expect(linkedDocumentPaths('[policy]: policy/onboarding.md "Onboarding"', 'README.md')).toEqual([
      'policy/onboarding.md',
    ]);
    expect(linkedDocumentPaths('   [policy]: <policy/onboarding.md>', 'README.md')).toEqual(['policy/onboarding.md']);
  });

  it('keeps the document a fragment link points at', () => {
    expect(linkedDocumentPaths('[x](policy/onboarding.md#setup)', 'README.md')).toEqual(['policy/onboarding.md']);
  });

  it('decodes a percent-encoded destination, which is how non-ASCII names travel', () => {
    expect(linkedDocumentPaths('[x](policy/%EC%97%B0%EA%B5%AC.md)', 'README.md')).toEqual(['policy/연구.md']);
  });

  it('ignores anything that is not a repository markdown document', () => {
    const markdown = [
      '[a](https://example.com/policy.md)',
      '[b](mailto:someone@example.com)',
      '[c](#a-heading)',
      '[d](assets/diagram.png)',
      '![e](assets/shot.png)',
      '[f](../../outside.md)',
    ].join('\n');
    expect(linkedDocumentPaths(markdown, 'README.md')).toEqual([]);
  });

  it('ignores links inside a fenced code block, which are samples and not references', () => {
    const markdown = [
      '[real](policy/onboarding.md)',
      '```markdown',
      '[sample](policy/example.md)',
      '```',
      '~~~',
      '[sample](policy/other.md)',
      '~~~',
      '[also real](policy/second.md)',
    ].join('\n');
    expect(linkedDocumentPaths(markdown, 'README.md')).toEqual(['policy/onboarding.md', 'policy/second.md']);
  });

  it('finds every link on a line, and images too', () => {
    expect(linkedDocumentPaths('[a](one.md) and [b](two.md)', 'README.md')).toEqual(['one.md', 'two.md']);
  });
});

describe('countInboundLinks', () => {
  let repoRoot: string;

  const write = (relativePath: string, content: string) => {
    const target = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
  };

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-links-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('counts the documents that link to a path, not the links', async () => {
    write('policy/onboarding.md', '# Onboarding\n');
    write('README.md', 'See [it](policy/onboarding.md) and [again](policy/onboarding.md).\n');
    write('guides/setup.md', 'See [it](../policy/onboarding.md).\n');
    write('guides/unrelated.md', 'Nothing here.\n');

    expect(await countInboundLinks(repoRoot, 'policy/onboarding.md')).toBe(2);
  });

  it('does not count the document’s links to itself', async () => {
    write('policy/onboarding.md', 'Back to [the top](onboarding.md).\n');

    expect(await countInboundLinks(repoRoot, 'policy/onboarding.md')).toBe(0);
  });

  it('does not count a sample inside a code fence', async () => {
    write('policy/onboarding.md', '# Onboarding\n');
    write('README.md', '```\n[x](policy/onboarding.md)\n```\n');

    expect(await countInboundLinks(repoRoot, 'policy/onboarding.md')).toBe(0);
  });

  it('counts a reference-style definition', async () => {
    write('policy/onboarding.md', '# Onboarding\n');
    write('README.md', 'See [the policy][p].\n\n[p]: policy/onboarding.md "Onboarding"\n');

    expect(await countInboundLinks(repoRoot, 'policy/onboarding.md')).toBe(1);
  });

  it('is zero when nothing points at the document', async () => {
    write('policy/onboarding.md', '# Onboarding\n');
    write('README.md', 'See [something else](policy/other.md).\n');

    expect(await countInboundLinks(repoRoot, 'policy/onboarding.md')).toBe(0);
  });
});
