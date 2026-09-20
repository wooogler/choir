// The filename suggestion is the one piece of the rename/new-document work
// that is pure: given the basenames a folder already holds, it answers with the
// name the folder would have chosen. Everything that could be wrong about it is
// wrong in the same way — a convention read off too few siblings, a separator
// borrowed from the wrong half of the name, padding dropped — so it is worth
// pinning each convention down on its own.
//
// It lives in the viewer (`web/src/utils/file-names.ts`) and is tested from the
// repository root, like `docs-api-errors.test.ts`: the root jest config
// compiles TypeScript wherever an import leads.

import { suggestFileNameFromSiblings } from '../web/src/utils/file-names';

const fallback = 'untitled';
const sept13 = new Date(2026, 8, 13);

describe('date-named folders', () => {
  it('follows `YYYY-MM-DD-slug`', () => {
    const result = suggestFileNameFromSiblings(
      ['2026-09-06-weekly-sync.md', '2026-08-30-weekly-sync.md', '2026-09-13-design-review.md'],
      { title: 'Roadmap Review', date: sept13, fallback },
    );
    expect(result.pattern).toBe('date');
    expect(result.placeholder).toBe('2026-09-13-roadmap-review.md');
  });

  it('keeps the folder’s own date spelling', () => {
    const compact = suggestFileNameFromSiblings(['20260906-sync.md', '20260830-sync.md'], {
      title: 'Roadmap Review',
      date: sept13,
      fallback,
    });
    expect(compact.placeholder).toBe('20260913-roadmap-review.md');

    const dotted = suggestFileNameFromSiblings(['2026.09.06_sync.md', '2026.08.30_sync.md'], {
      title: 'Roadmap Review',
      date: sept13,
      fallback,
    });
    expect(dotted.placeholder).toBe('2026.09.13_roadmap_review.md');
  });

  it('stamps today when no date is given', () => {
    const today = new Date();
    const result = suggestFileNameFromSiblings(['2026-09-06-sync.md', '2026-08-30-sync.md'], {
      title: 'Sync',
      fallback,
    });
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate(),
    ).padStart(2, '0')}-sync.md`;
    expect(result.placeholder).toBe(expected);
  });

  it('offers the three most recent siblings as examples', () => {
    const result = suggestFileNameFromSiblings(
      ['2026-08-16-a.md', '2026-09-06-b.md', '2026-07-01-c.md', '2026-09-13-d.md'],
      { title: 'Sync', date: sept13, fallback },
    );
    expect(result.examples).toEqual(['2026-09-13-d.md', '2026-09-06-b.md', '2026-08-16-a.md']);
  });

  it('is not fooled by a long number', () => {
    // 1234 is not a year, so this is a numbered folder, not a dated one.
    const result = suggestFileNameFromSiblings(['1234-5678-notes.md', '1234-5679-notes.md'], {
      title: 'Sync',
      date: sept13,
      fallback,
    });
    expect(result.pattern).toBe('number');
  });
});

describe('numbered folders', () => {
  it('takes the next number and keeps the padding', () => {
    const result = suggestFileNameFromSiblings(['01-onboarding.md', '02-tooling.md', '09-glossary.md'], {
      title: 'Deployment',
      fallback,
    });
    expect(result.pattern).toBe('number');
    expect(result.placeholder).toBe('10-deployment.md');
  });

  it('pads to the widest sibling', () => {
    const result = suggestFileNameFromSiblings(['001.intro.md', '002.setup.md', '003.deploy.md'], {
      title: 'Rollback',
      fallback,
    });
    expect(result.placeholder).toBe('004.rollback.md');
  });

  it('keeps an unpadded folder unpadded', () => {
    const result = suggestFileNameFromSiblings(['1_intro.md', '2_setup.md'], { title: 'Deploy Notes', fallback });
    expect(result.placeholder).toBe('3_deploy_notes.md');
  });

  it('counts down from the highest number for examples', () => {
    const result = suggestFileNameFromSiblings(['01-a.md', '04-d.md', '02-b.md', '03-c.md'], {
      title: 'Next',
      fallback,
    });
    expect(result.examples).toEqual(['04-d.md', '03-c.md', '02-b.md']);
  });
});

describe('plain folders', () => {
  it('uses the folder’s separator and case', () => {
    const dashed = suggestFileNameFromSiblings(['weekly-sync.md', 'design-review.md'], {
      title: 'Roadmap Review',
      fallback,
    });
    expect(dashed.pattern).toBe('plain');
    expect(dashed.placeholder).toBe('roadmap-review.md');

    const shouted = suggestFileNameFromSiblings(['Weekly_Sync_0913.md', 'Design_Review_0906.md'], {
      title: 'Roadmap Review',
      fallback,
    });
    expect(shouted.placeholder).toBe('Roadmap_Review.md');
  });

  it('shows the last three siblings alphabetically', () => {
    const result = suggestFileNameFromSiblings(['alpha.md', 'delta.md', 'bravo.md', 'charlie.md'], {
      title: 'Echo',
      fallback,
    });
    expect(result.examples).toEqual(['bravo.md', 'charlie.md', 'delta.md']);
  });
});

describe('folders that have not made up their mind', () => {
  it('falls back to plain when no convention holds a majority', () => {
    const result = suggestFileNameFromSiblings(['2026-09-06-sync.md', '01-onboarding.md', 'glossary.md', 'readme.md'], {
      title: 'Roadmap Review',
      date: sept13,
      fallback,
    });
    expect(result.pattern).toBe('plain');
    expect(result.placeholder).toBe('roadmap-review.md');
  });

  it('needs a strict majority, not a tie', () => {
    const result = suggestFileNameFromSiblings(['2026-09-06-sync.md', '2026-08-30-sync.md', 'a.md', 'b.md'], {
      title: 'Sync',
      date: sept13,
      fallback,
    });
    expect(result.pattern).toBe('plain');
  });
});

describe('Korean titles', () => {
  it('keeps Hangul as it is', () => {
    const result = suggestFileNameFromSiblings(['2026-09-06-주간회의.md', '2026-08-30-주간회의.md'], {
      title: '주간 회의록',
      date: sept13,
      fallback,
    });
    expect(result.placeholder).toBe('2026-09-13-주간-회의록.md');
  });

  it('keeps Hangul in a plain folder too', () => {
    const result = suggestFileNameFromSiblings(['용어집.md', '온보딩.md'], { title: '배포 안내', fallback });
    expect(result.placeholder).toBe('배포-안내.md');
  });
});

describe('the edges', () => {
  it('has an answer for an empty folder', () => {
    const result = suggestFileNameFromSiblings([], { title: 'Roadmap Review', fallback });
    expect(result).toEqual({ placeholder: 'roadmap-review.md', pattern: 'plain', examples: [] });
  });

  it('uses the fallback for an empty title, prefix and all', () => {
    expect(suggestFileNameFromSiblings([], { title: '   ', fallback }).placeholder).toBe('untitled.md');
    expect(
      suggestFileNameFromSiblings(['2026-09-06-sync.md', '2026-08-30-sync.md'], { title: '', date: sept13, fallback })
        .placeholder,
    ).toBe('2026-09-13-untitled.md');
    expect(suggestFileNameFromSiblings(['01-a.md', '02-b.md'], { title: '…', fallback }).placeholder).toBe(
      '03-untitled.md',
    );
  });

  it('ignores whatever is not markdown', () => {
    const result = suggestFileNameFromSiblings(['image.png', '01-a.md', '02-b.md', 'notes.txt'], {
      title: 'Next',
      fallback,
    });
    expect(result.pattern).toBe('number');
    expect(result.placeholder).toBe('03-next.md');
  });

  it('always ends in .md', () => {
    for (const siblings of [[], ['2026-09-06-a.md'], ['01-a.md', '02-b.md'], ['a.md', 'b.md']]) {
      expect(suggestFileNameFromSiblings(siblings, { title: 'x', fallback }).placeholder).toMatch(/\.md$/);
    }
  });
});
