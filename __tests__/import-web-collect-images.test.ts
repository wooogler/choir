import crypto from 'node:crypto';
import type { RemoteImage } from 'services/document/image-captions/fetch-remote-image';
import { collectImages, rewriteImageReferences } from 'services/import/sources/web/collect-images';

/** A real 1×1 PNG: the magic-byte checks are the point, so the bytes must be real. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_BASE64, 'base64');
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80])]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF', 'latin1')]);
const NOT_AN_IMAGE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf-8');

const pathFor = (bytes: Buffer, extension: string): string =>
  `assets/${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 40)}.${extension}`;

const serve = (table: Record<string, RemoteImage | null>) => async (url: string) => table[url] ?? null;

describe('collectImages', () => {
  it('content-addresses each image the way the web editor does', async () => {
    const result = await collectImages(['https://example.com/a.png'], {
      fetchImage: serve({ 'https://example.com/a.png': { bytes: PNG, contentType: 'image/png' } }),
    });

    expect(result.assets).toEqual([{ path: pathFor(PNG, 'png'), bytes: PNG, contentType: 'image/png' }]);
    expect(result.assets[0].path).toMatch(/^assets\/[0-9a-f]{40}\.png$/);
    expect(result.rewrite.get('https://example.com/a.png')).toBe(pathFor(PNG, 'png'));
    expect(result.rejected).toEqual([]);
  });

  it('trusts magic bytes over the declared content type', async () => {
    const result = await collectImages(['https://example.com/says-png.png'], {
      fetchImage: serve({ 'https://example.com/says-png.png': { bytes: JPEG, contentType: 'image/png' } }),
    });

    expect(result.assets[0].path).toBe(pathFor(JPEG, 'jpg'));
    expect(result.assets[0].contentType).toBe('image/jpeg');
  });

  it('stores identical bytes once and points both references at it', async () => {
    const urls = ['https://example.com/a.png', 'https://example.com/copy.png', 'https://example.com/b.gif'];
    const result = await collectImages(urls, {
      fetchImage: serve({
        'https://example.com/a.png': { bytes: PNG, contentType: 'image/png' },
        'https://example.com/copy.png': { bytes: PNG, contentType: 'image/png' },
        'https://example.com/b.gif': { bytes: GIF, contentType: 'image/gif' },
      }),
    });

    expect(result.assets).toHaveLength(2);
    expect(result.rewrite.get(urls[0])).toBe(result.rewrite.get(urls[1]));
    expect(result.rewrite.get(urls[2])).toBe(pathFor(GIF, 'gif'));
  });

  it('refuses images past the per-page count, keeping the first ones', async () => {
    const urls = ['https://example.com/1.png', 'https://example.com/2.png', 'https://example.com/3.png'];
    const result = await collectImages(urls, {
      maxImages: 2,
      fetchImage: async (url) => ({ bytes: Buffer.concat([PNG, Buffer.from(url)]), contentType: 'image/png' }),
    });

    expect(result.assets).toHaveLength(2);
    expect(result.rewrite.has('https://example.com/3.png')).toBe(false);
    expect(result.rejected).toEqual([{ reason: 'too_many_images', contentType: 'unknown', bytes: 0 }]);
  });

  it('refuses an image that is too big on its own', async () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
    const result = await collectImages(['https://example.com/huge.png'], {
      fetchImage: serve({ 'https://example.com/huge.png': { bytes: huge, contentType: 'image/png' } }),
    });

    expect(result.assets).toEqual([]);
    expect(result.rejected).toEqual([{ reason: 'image_too_large', contentType: 'image/png', bytes: huge.length }]);
  });

  it('spends the total budget on the images the reader meets first', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(600)]);
    const urls = ['https://example.com/1.png', 'https://example.com/2.png', 'https://example.com/3.png'];
    const result = await collectImages(urls, {
      // Room for the first small image and one big one, but not for two.
      maxTotalBytes: PNG.length + big.length + 5,
      fetchImage: async (url) => ({
        // The trailing marker keeps the two big images from de-duplicating.
        bytes: url.endsWith('1.png') ? PNG : Buffer.concat([big, Buffer.from(url.slice(-5))]),
        contentType: 'image/png',
      }),
    });

    expect([...result.rewrite.keys()]).toEqual([urls[0], urls[1]]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('image_too_large');
  });

  it('reports an image it could not fetch, or could not recognise', async () => {
    const result = await collectImages(['https://example.com/gone.png', 'https://example.com/vector.svg'], {
      fetchImage: serve({
        'https://example.com/gone.png': null,
        'https://example.com/vector.svg': { bytes: NOT_AN_IMAGE, contentType: 'image/svg+xml' },
      }),
    });

    expect(result.assets).toEqual([]);
    expect(result.rejected).toEqual([
      { reason: 'unsupported_image_type', contentType: 'unknown', bytes: 0 },
      { reason: 'unsupported_image_type', contentType: 'image/svg+xml', bytes: NOT_AN_IMAGE.length },
    ]);
  });

  it('survives a fetcher that throws', async () => {
    const result = await collectImages(['https://example.com/boom.png'], {
      fetchImage: async () => {
        throw new Error('socket hang up');
      },
    });

    expect(result.assets).toEqual([]);
    expect(result.rejected[0].reason).toBe('unsupported_image_type');
  });

  it('decodes inline data URIs without going near the network', async () => {
    const dataUri = `data:image/png;base64,${PNG_BASE64}`;
    const fetchImage = jest.fn(async () => null);
    const result = await collectImages([dataUri], { fetchImage });

    expect(fetchImage).not.toHaveBeenCalled();
    expect(result.assets).toEqual([{ path: pathFor(PNG, 'png'), bytes: PNG, contentType: 'image/png' }]);
    expect(result.rewrite.get(dataUri)).toBe(pathFor(PNG, 'png'));
  });

  it('refuses a data URI that is not really an image', async () => {
    const result = await collectImages(['data:image/png;base64,aGVsbG8gd29ybGQ='], {});

    expect(result.assets).toEqual([]);
    expect(result.rejected[0].reason).toBe('unsupported_image_type');
  });
});

describe('rewriteImageReferences', () => {
  const rewrite = new Map([['https://example.com/a.png', 'assets/abc.png']]);

  it('points a kept image at its committed path, title and all', () => {
    const markdown = '![A](https://example.com/a.png)\n\n![A](https://example.com/a.png "Figure 1")';

    expect(rewriteImageReferences(markdown, rewrite, new Set())).toBe(
      '![A](assets/abc.png)\n\n![A](assets/abc.png "Figure 1")',
    );
  });

  it('leaves the alt text behind when an image was dropped', () => {
    const markdown = 'Before.\n\n![Missing chart](https://example.com/gone.png)\n\nAfter.';
    const result = rewriteImageReferences(markdown, new Map(), new Set(['https://example.com/gone.png']));

    expect(result).toBe('Before.\n\nMissing chart\n\nAfter.');
  });

  it('removes a dropped image that had nothing to say', () => {
    const markdown = 'Before.\n\n![](https://example.com/gone.png)\n\nAfter.';

    expect(rewriteImageReferences(markdown, new Map(), new Set(['https://example.com/gone.png']))).toBe(
      'Before.\n\nAfter.',
    );
  });

  it('rewrites an image whose URL remark wrapped in angle brackets', () => {
    const markdown = '![A](<https://example.com/a.png>)';

    expect(rewriteImageReferences(markdown, rewrite, new Set())).toBe('![A](assets/abc.png)');
  });

  it('leaves references it was told nothing about alone', () => {
    const markdown = '![B](https://example.com/b.png)';

    expect(rewriteImageReferences(markdown, rewrite, new Set())).toBe(markdown);
  });
});
