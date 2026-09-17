import {
  LINK_DESCRIPTION,
  LINK_DESCRIPTION_KO,
  REPLICA_BANNER,
  REPLICA_BANNER_KO,
  linkDescription,
  stripBanner,
  withBanner,
} from 'services/google/banner';

describe('replica banner', () => {
  it('prepends the banner with a blank line after it', () => {
    expect(withBanner('# Title\n\nBody')).toBe(`${REPLICA_BANNER}\n\n# Title\n\nBody`);
  });

  it('round-trips: stripping what it added returns the original', () => {
    const original = '# Title\n\nBody\n';
    expect(stripBanner(withBanner(original)).body).toBe(original);
  });

  it('does not stack banners when publishing twice', () => {
    const once = withBanner('# Title');
    expect(withBanner(once)).toBe(once);
  });

  it('reports a document that has no banner', () => {
    const result = stripBanner('# Title\n\nBody');
    expect(result.hadBanner).toBe(false);
    expect(result.body).toBe('# Title\n\nBody');
  });

  it('strips a banner whose wording predates the current one', () => {
    // Baselines written by an earlier deploy still hold the old text. An
    // exact-match strip would leave it in place and report a banner-only drift
    // for every document at once.
    const legacy =
      '*이 문서는 GitHub에서 자동 생성된 복제본입니다. 여기서 편집한 내용은 반영되지 않습니다.*\n\n# Title';
    const result = stripBanner(legacy);
    expect(result.hadBanner).toBe(true);
    expect(result.body).toBe('# Title');
  });

  it('strips a banner that lost or gained emphasis markers in a round trip', () => {
    for (const line of [
      'This document is a read-only replica of a GitHub document, synced by CHOIR.',
      '**This document is a read-only replica of a GitHub document, synced by CHOIR.**',
      '_This document is a read-only replica of a GitHub document, synced by CHOIR._',
    ]) {
      expect(stripBanner(`${line}\n\n# Title`).hadBanner).toBe(true);
    }
  });

  it('strips a banner that Docs escaped on the way out', () => {
    const escaped = '*This document is a read-only replica of a GitHub document, synced by CHOIR\\. Edits\\.*';
    expect(stripBanner(`${escaped}\n\n# Title`).body).toBe('# Title');
  });

  it('ignores leading blank lines before the banner', () => {
    expect(stripBanner(`\n\n${REPLICA_BANNER}\n\n# Title`).body).toBe('# Title');
  });

  it('leaves a body that merely mentions replicas alone', () => {
    const body = 'This document is a read-only summary of our process.\n\n# Title';
    const result = stripBanner(body);
    expect(result.hadBanner).toBe(false);
    expect(result.body).toBe(body);
  });

  it('keeps body content that follows immediately with no blank line', () => {
    expect(stripBanner(`${REPLICA_BANNER}\n# Title`).body).toBe('# Title');
  });

  it('handles an empty document', () => {
    expect(stripBanner('')).toEqual({ body: '', hadBanner: false });
    expect(withBanner('')).toBe(`${REPLICA_BANNER}\n\n`);
  });
});

describe('the banner follows the content language', () => {
  it('writes the Korean banner when asked, and English by default', () => {
    expect(withBanner('# 제목', 'ko')).toBe(`${REPLICA_BANNER_KO}\n\n# 제목`);
    expect(withBanner('# Title', 'en')).toBe(`${REPLICA_BANNER}\n\n# Title`);
    expect(withBanner('# Title')).toBe(`${REPLICA_BANNER}\n\n# Title`);
  });

  it('strips both banners, and the legacy opening still strips', () => {
    for (const banner of [
      REPLICA_BANNER,
      REPLICA_BANNER_KO,
      '*이 문서는 GitHub에서 자동 생성된 복제본입니다. 여기서 편집한 내용은 반영되지 않습니다.*',
    ]) {
      const result = stripBanner(`${banner}\n\n# Title\n\nBody`);
      expect(result.hadBanner).toBe(true);
      expect(result.body).toBe('# Title\n\nBody');
    }
  });

  it('replaces rather than stacks when the workspace switches language', () => {
    expect(withBanner(withBanner('# Title', 'en'), 'ko')).toBe(`${REPLICA_BANNER_KO}\n\n# Title`);
    expect(withBanner(withBanner('# Title', 'ko'), 'en')).toBe(`${REPLICA_BANNER}\n\n# Title`);
  });

  it('picks the Drive description in the same language', () => {
    expect(linkDescription('ko')).toBe(LINK_DESCRIPTION_KO);
    expect(linkDescription('en')).toBe(LINK_DESCRIPTION);
    expect(linkDescription()).toBe(LINK_DESCRIPTION);
  });
});
