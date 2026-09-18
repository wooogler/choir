import { normalizeAssetPath, prepareCommit } from '../services/import/commit-guard';
import type { ConvertedDocument, ImportAsset } from '../services/import/types';
import { ImportRefusal } from '../services/import/types';

/**
 * The commit guard stands between markdown a browser sent and a commit, so the
 * cases that matter are the adversarial and the careless ones: a reference to a
 * binary the draft never held, and an image the manager deleted in the preview
 * that must not be committed anyway.
 */

function asset(path: string): ImportAsset {
  return { path, bytes: Buffer.from('png'), contentType: 'image/png' };
}

function draft(assets: ImportAsset[]): ConvertedDocument {
  return {
    markdown: 'ignored: the client returns its own edited body',
    title: 'Onboarding',
    assets,
    rejectedAssets: [],
    warnings: [],
    source: { kind: 'url', name: 'example.com', url: 'https://example.com' },
  };
}

describe('normalizeAssetPath', () => {
  it('reduces every spelling of the repository assets directory to one', () => {
    expect(normalizeAssetPath('assets/a.png')).toBe('assets/a.png');
    expect(normalizeAssetPath('./assets/a.png')).toBe('assets/a.png');
    expect(normalizeAssetPath('/assets/a.png')).toBe('assets/a.png');
    expect(normalizeAssetPath('  <assets/a.png>  ')).toBe('assets/a.png');
  });
});

describe('prepareCommit', () => {
  it('keeps an image the draft holds, however the body spells it', () => {
    const document = draft([asset('assets/a.png')]);
    const result = prepareCommit({
      markdown: '# Title\n\n![One](./assets/a.png)\n\n![Two](/assets/a.png "caption")\n',
      document,
    });

    expect(result.droppedReferences).toEqual([]);
    expect(result.markdown).toContain('![One](./assets/a.png)');
    expect(result.markdown).toContain('![Two](/assets/a.png "caption")');
    expect(result.assets.map((a) => a.path)).toEqual(['assets/a.png']);
  });

  it('removes a reference to an asset the draft never held, keeping the alt text', () => {
    const result = prepareCommit({
      markdown: '# Title\n\nBefore ![Org chart](assets/ghost.png) after.\n',
      document: draft([]),
    });

    expect(result.markdown).toContain('Before Org chart after.');
    expect(result.markdown).not.toContain('assets/ghost.png');
    expect(result.droppedReferences).toEqual(['assets/ghost.png']);
  });

  it('removes the image entirely when there is no alt text to keep', () => {
    const result = prepareCommit({
      markdown: '# Title\n\nParagraph one.\n\n![](assets/ghost.png)\n\nParagraph two.\n',
      document: draft([]),
    });

    expect(result.markdown).toBe('# Title\n\nParagraph one.\n\nParagraph two.\n');
    expect(result.droppedReferences).toEqual(['assets/ghost.png']);
  });

  it('leaves links out to the web alone', () => {
    const markdown =
      '# Title\n\n![Remote](https://example.com/a.png)\n\n![Sibling](../other/b.png)\n\n[A link](https://example.com)\n';
    const result = prepareCommit({ markdown, document: draft([]) });

    expect(result.markdown).toBe(markdown);
    expect(result.droppedReferences).toEqual([]);
  });

  it('does not commit an asset the manager deleted from the body', () => {
    const document = draft([asset('assets/kept.png'), asset('assets/deleted.png')]);
    const result = prepareCommit({ markdown: '# Title\n\n![Kept](assets/kept.png)\n', document });

    expect(result.assets.map((a) => a.path)).toEqual(['assets/kept.png']);
    // Deleting an image is not an error, so nothing is reported about it.
    expect(result.droppedReferences).toEqual([]);
  });

  it('follows reference-style images and takes the dead definition with them', () => {
    const document = draft([asset('assets/live.png')]);
    const result = prepareCommit({
      markdown:
        '# Title\n\n![Live][live]\n\n![Dead][dead]\n\n[live]: assets/live.png\n[dead]: assets/ghost.png "caption"\n',
      document,
    });

    expect(result.markdown).toContain('![Live][live]');
    expect(result.markdown).toContain('[live]: assets/live.png');
    expect(result.markdown).toContain('\nDead\n');
    expect(result.markdown).not.toContain('assets/ghost.png');
    expect(result.droppedReferences).toEqual(['assets/ghost.png']);
    expect(result.assets.map((a) => a.path)).toEqual(['assets/live.png']);
  });

  it('resolves a collapsed reference by its alt text', () => {
    const result = prepareCommit({
      markdown: '# Title\n\n![Ghost][]\n\n[ghost]: assets/ghost.png\n',
      document: draft([]),
    });

    expect(result.markdown).not.toContain('assets/ghost.png');
    expect(result.droppedReferences).toEqual(['assets/ghost.png']);
  });

  it('leaves a reference with no definition as the literal text it renders as', () => {
    const markdown = '# Title\n\n![Nothing][missing-id]\n';
    expect(prepareCommit({ markdown, document: draft([]) }).markdown).toBe(markdown);
  });

  it('does not rewrite an example inside a code fence', () => {
    const markdown = '# Title\n\n```md\n![Sample](assets/ghost.png)\n```\n\n![Real](assets/ghost.png)\n';
    const result = prepareCommit({ markdown, document: draft([]) });

    expect(result.markdown).toContain('```md\n![Sample](assets/ghost.png)\n```');
    expect(result.markdown).toContain('Real');
    expect(result.markdown.match(/assets\/ghost\.png/g)).toHaveLength(1);
  });

  it('reports each missing asset once, in the order it appeared', () => {
    const result = prepareCommit({
      markdown: '![a](assets/b.png)\n\n![b](assets/a.png)\n\n![c](assets/b.png)\n',
      document: draft([]),
    });

    expect(result.droppedReferences).toEqual(['assets/b.png', 'assets/a.png']);
  });

  it('leaves untouched markdown byte-identical', () => {
    const markdown = '# Title\n\nA paragraph with  \na hard line break.\n\n\n\nAnd a wide gap above.\n';
    expect(prepareCommit({ markdown, document: draft([]) }).markdown).toBe(markdown);
  });

  it('refuses a body with nothing in it', () => {
    let refusal: ImportRefusal | null = null;
    try {
      prepareCommit({ markdown: '   \n\n\t\n', document: draft([]) });
    } catch (error) {
      refusal = error as ImportRefusal;
    }

    expect(refusal).toBeInstanceOf(ImportRefusal);
    expect([refusal?.status, refusal?.code]).toEqual([400, 'import_empty']);
  });
});
