import { formatContext } from 'services/llm/qa-service';

describe('formatContext', () => {
  it('labels references with the QMD metadata identity (sectionName + path), not "Reference N"', () => {
    const docs = [
      {
        pageContent: 'The retry limit is 5.',
        metadata: { sectionName: 'Retry policy', headingPath: 'Retry policy', fileName: 'ops/retries.md' },
      },
    ];
    const out = formatContext(docs);
    expect(out).toContain('Retry policy');
    expect(out).toContain('ops/retries.md');
    expect(out).toContain('The retry limit is 5.');
    expect(out).not.toContain('Reference 1');
  });

  it('falls back to the file path when there is no section name', () => {
    const docs = [{ pageContent: 'body', metadata: { fileName: 'guide/intro.md' } }];
    expect(formatContext(docs)).toContain('--- guide/intro.md ---');
  });

  it('does not duplicate when the name equals the path', () => {
    const docs = [{ pageContent: 'body', metadata: { sectionName: 'README.md', fileName: 'README.md' } }];
    expect(formatContext(docs)).toContain('--- README.md ---');
    expect(formatContext(docs)).not.toContain('README.md (README.md)');
  });

  it('still honors a provider that sets title/source', () => {
    const docs = [{ pageContent: 'body', metadata: { title: 'My Title' } }];
    expect(formatContext(docs)).toContain('--- My Title ---');
  });

  it('falls back to Reference N only when no identity is present', () => {
    const docs = [{ pageContent: 'anon', metadata: {} }];
    expect(formatContext(docs)).toContain('--- Reference 1 ---');
  });

  it('joins multiple references', () => {
    const docs = [
      { pageContent: 'a', metadata: { fileName: 'a.md' } },
      { pageContent: 'b', metadata: { fileName: 'b.md' } },
    ];
    const out = formatContext(docs);
    expect(out).toContain('--- a.md ---');
    expect(out).toContain('--- b.md ---');
  });
});
