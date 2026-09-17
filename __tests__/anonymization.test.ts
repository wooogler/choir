import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolate the on-disk cache the service writes to before importing it.
const DATA_DIR = path.join(os.tmpdir(), `choir-anon-test-${process.pid}`);
process.env.CHOIR_DATA_DIR = DATA_DIR;

import { type AnonymizationData, AnonymizationService } from '../services/anonymization/anonymization-service';

// getAnonymizationMapping persists to disk; wipe the cache before each test so
// one test's writes never bleed into another via the shared cache file.
beforeEach(() => {
  fs.rmSync(path.join(DATA_DIR, 'cache'), { recursive: true, force: true });
});

function serviceWith(data: AnonymizationData['anonymization']): AnonymizationService {
  const svc = new AnonymizationService();
  // Control the mappings directly for deterministic assertions (the public
  // getAnonymizationMapping generates random fake names).
  (svc as unknown as { anonymizationData: AnonymizationData }).anonymizationData = { anonymization: data };
  return svc;
}

describe('anonymizeText', () => {
  it('masks a Korean (non-ASCII) name — regression for ASCII-only \\b boundaries', () => {
    const svc = serviceWith({
      U1: { realName: '김철수', fakeName: 'Alex Kim', fakeNickname: 'Alex', lastUsed: new Date().toISOString() },
    });
    const out = svc.anonymizeText('오늘 김철수 님이 회의를 진행했습니다.');
    expect(out).not.toContain('김철수');
    expect(out).toContain('Alex');
  });

  it('masks a Korean name adjacent to punctuation', () => {
    const svc = serviceWith({
      U1: { realName: '이영희', fakeName: 'Jamie Lee', fakeNickname: 'Jamie', lastUsed: new Date().toISOString() },
    });
    expect(svc.anonymizeText('(이영희) 확인함')).not.toContain('이영희');
    expect(svc.anonymizeText('담당: 이영희, 검토 완료')).not.toContain('이영희');
  });

  it('still masks an ASCII full name and first name (unchanged behavior)', () => {
    const svc = serviceWith({
      U1: { realName: 'John Smith', fakeName: 'Alex Kim', fakeNickname: 'Alex', lastUsed: new Date().toISOString() },
    });
    expect(svc.anonymizeText('John Smith joined')).toContain('Alex');
    expect(svc.anonymizeText('ask John about it')).toContain('Alex');
  });

  it('does not over-match a name embedded inside a longer word', () => {
    const svc = serviceWith({
      U1: { realName: 'Lee', fakeName: 'Robin Park', fakeNickname: 'Robin', lastUsed: new Date().toISOString() },
    });
    // "Leeds" must stay intact; only the standalone name is replaced.
    const out = svc.anonymizeText('The Leeds office; ask Lee directly.');
    expect(out).toContain('Leeds');
    expect(out).toContain('Robin');
  });

  it('masks a Korean name fused with a particle or honorific, keeping the suffix', () => {
    const svc = serviceWith({
      U1: { realName: '김철수', fakeName: 'Alex Kim', fakeNickname: 'Alex', lastUsed: new Date().toISOString() },
    });
    // Korean glues particles/honorifics straight onto the name with no space; the
    // old letter-boundary lookahead rejected these and leaked the real name.
    const cases: Array<[string, string]> = [
      ['김철수가 회의를 열었다', 'Alex가 회의를 열었다'],
      ['김철수를 불러주세요', 'Alex를 불러주세요'],
      ['김철수님 확인 부탁드립니다', 'Alex님 확인 부탁드립니다'],
      ['김철수에게 전달했습니다', 'Alex에게 전달했습니다'],
      ['김철수이랑 같이 했어요', 'Alex이랑 같이 했어요'],
      ['김철수님이 승인했습니다', 'Alex님이 승인했습니다'],
    ];
    for (const [input, expected] of cases) {
      const out = svc.anonymizeText(input);
      expect(out).not.toContain('김철수');
      expect(out).toBe(expected);
    }
  });

  it('prefers the longest suffix (에게 over 에, 이랑 over 이)', () => {
    const svc = serviceWith({
      U1: { realName: '김철수', fakeName: 'Alex Kim', fakeNickname: 'Alex', lastUsed: new Date().toISOString() },
    });
    // A shorter alternative matching first would strip the rest of the particle.
    expect(svc.anonymizeText('김철수에게')).toBe('Alex에게');
    expect(svc.anonymizeText('김철수이랑')).toBe('Alex이랑');
  });

  it('masks a given name fused with an honorific via the stored nickname', () => {
    const svc = serviceWith({
      U1: {
        realName: '김철수',
        nickname: '철수',
        fakeName: 'Alex Kim',
        fakeNickname: 'Alex',
        lastUsed: new Date().toISOString(),
      },
    });
    expect(svc.anonymizeText('철수씨 오셨어요')).toBe('Alex씨 오셨어요');
    expect(svc.anonymizeText('김철수 교수님과 상의')).not.toContain('김철수');
  });

  it('does not let the Korean suffix rule over-match a Latin name (John vs Johnson)', () => {
    const svc = serviceWith({
      U1: { realName: 'John Smith', fakeName: 'Alex Kim', fakeNickname: 'Alex', lastUsed: new Date().toISOString() },
    });
    // The boundary lookahead still applies after the (empty) optional suffix.
    const out = svc.anonymizeText('Johnson emailed John about Johnsonville');
    expect(out).toBe('Johnson emailed Alex about Johnsonville');
  });

  it('skips the first-name fallback for a name with no space (no single-syllable matching)', () => {
    const svc = serviceWith({
      U1: { realName: '김철수', fakeName: 'Alex Kim', fakeNickname: 'Alex', lastUsed: new Date().toISOString() },
    });
    // "김" alone is a surname syllable AND an ordinary word fragment; it must never be
    // treated as a "first name". Only the whole name is masked.
    const out = svc.anonymizeText('김밥과 김치를 먹었다. 김철수가 왔다.');
    expect(out).toBe('김밥과 김치를 먹었다. Alex가 왔다.');
  });

  it('skips a one-syllable Hangul surname token of a spaced name', () => {
    const svc = serviceWith({
      U1: { realName: '김 철수', fakeName: 'Alex Kim', fakeNickname: 'Alex', lastUsed: new Date().toISOString() },
    });
    const out = svc.anonymizeText('김 사원과 김 철수가 참석');
    expect(out).toContain('김 사원'); // the bare surname is untouched
    expect(out).toContain('Alex가');
  });

  it('replaces a Slack user-id mention with the fake nickname', () => {
    const svc = serviceWith({
      U1: { realName: '김철수', fakeName: 'Alex Kim', fakeNickname: 'Alex', lastUsed: new Date().toISOString() },
    });
    expect(svc.anonymizeText('cc <@U1> please')).toContain('Alex');
  });
});

describe('deAnonymizeText', () => {
  it('restores real names from fake names for a Korean mapping', () => {
    const svc = serviceWith({
      U1: {
        realName: '김철수',
        nickname: '철수',
        fakeName: 'Alex Kim',
        fakeNickname: 'Alex',
        lastUsed: new Date().toISOString(),
      },
    });
    const out = svc.deAnonymizeText('Alex Kim reviewed the doc. Alex approved.');
    expect(out).toContain('김철수');
    expect(out).toContain('철수');
  });

  it('restores a pseudonym fused with a Korean particle', () => {
    const svc = serviceWith({
      U1: { realName: '김철수', fakeName: 'Alex Kim', fakeNickname: 'Alex', lastUsed: new Date().toISOString() },
    });
    // The particle attached to the pseudonym is the ORIGINAL one (anonymizeText only
    // swapped the name part), so restoring the name and keeping the particle is exact.
    expect(svc.deAnonymizeText('Alex가 승인했습니다')).toBe('김철수가 승인했습니다');
    expect(svc.deAnonymizeText('Alex에게 물어보세요')).toBe('김철수에게 물어보세요');
    expect(svc.deAnonymizeText('Alex님이 답했습니다')).toBe('김철수님이 답했습니다');
  });

  it('round-trips a Korean sentence with several fused particles byte-for-byte', () => {
    const svc = serviceWith({
      // No nickname on U1: a space-less Korean name has no separable first name, so
      // the whole real name is what gets masked and what gets restored.
      U1: { realName: '김철수', fakeName: 'Alex Kim', fakeNickname: 'Alex', lastUsed: new Date().toISOString() },
      U2: {
        realName: '이영희',
        fakeName: 'Jamie Lee',
        fakeNickname: 'Jamie',
        lastUsed: new Date(Date.now() - 1000).toISOString(),
      },
    });
    const original = '김철수가 이영희에게 보고했고, 김철수님은 이영희와 함께 김철수를 대신해 발표했다.';

    const masked = svc.anonymizeText(original);
    expect(masked).not.toContain('김철수');
    expect(masked).not.toContain('이영희');
    // Particles survive the masking pass untouched.
    expect(masked).toContain('Alex가');
    expect(masked).toContain('Jamie에게');

    expect(svc.deAnonymizeText(masked)).toBe(original);
  });
});

describe('workspace scoping', () => {
  it('does not leak a workspace-A name into workspace-B text (cross-tenant)', () => {
    const svc = new AnonymizationService();
    // Inject explicit, deliberately non-overlapping fake names. Minting them via
    // getAnonymizationMapping draws from a shared random name pool, so the two
    // workspaces' fakes occasionally shared a surname and flaked the pass-through
    // assertion below — the cross-tenant invariant itself doesn't depend on that.
    (svc as unknown as { anonymizationData: AnonymizationData }).anonymizationData = {
      anonymization: {
        'TWS_A:U1': {
          realName: 'Alice Anderson',
          fakeName: 'Quinn Zeta',
          fakeNickname: 'Quinn',
          lastUsed: new Date().toISOString(),
        },
        'TWS_B:U2': {
          realName: 'Bob Brown',
          fakeName: 'Victor Yang',
          fakeNickname: 'Victor',
          lastUsed: new Date().toISOString(),
        },
      },
    };
    const aFake = 'Quinn Zeta';
    const bFake = 'Victor Yang';

    // Workspace B de-anonymizing text that contains workspace A's fake name must
    // NOT reveal workspace A's real name, and (since B has no such mapping) leaves
    // the fake name untouched.
    expect(svc.deAnonymizeText(`ping ${aFake}`, 'TWS_B')).not.toContain('Alice Anderson');
    expect(svc.deAnonymizeText(`ping ${aFake}`, 'TWS_B')).toContain(aFake);

    // Within its own workspace it de-anonymizes correctly.
    expect(svc.deAnonymizeText(`ping ${aFake}`, 'TWS_A')).toContain('Alice Anderson');
    // And workspace B's own mapping still works.
    expect(svc.deAnonymizeText(`hi ${bFake}`, 'TWS_B')).toContain('Bob Brown');
  });

  it('anonymizes only the current workspace real names', () => {
    const svc = new AnonymizationService();
    (svc as unknown as { anonymizationData: AnonymizationData }).anonymizationData = { anonymization: {} };
    svc.getAnonymizationMapping('U1', 'Alice Anderson', undefined, 'TWS_A');

    // Workspace B has no mapping for "Alice Anderson", so it is left as-is there
    // (workspace A would mask it).
    expect(svc.anonymizeText('met Alice Anderson today', 'TWS_B')).toContain('Alice Anderson');
    expect(svc.anonymizeText('met Alice Anderson today', 'TWS_A')).not.toContain('Alice Anderson');
  });

  it('mints independent fake names per workspace without cross-workspace collision checks', () => {
    const svc = new AnonymizationService();
    (svc as unknown as { anonymizationData: AnonymizationData }).anonymizationData = { anonymization: {} };
    const a = svc.getAnonymizationMapping('U1', 'Alice Anderson', undefined, 'TWS_A');
    const b = svc.getAnonymizationMapping('U1', 'Alice Anderson', undefined, 'TWS_B');
    // Same userId in two workspaces are stored as distinct, independently-keyed
    // mappings (both valid; fakes may or may not coincide across workspaces).
    expect(a.realName).toBe('Alice Anderson');
    expect(b.realName).toBe('Alice Anderson');
  });

  it('purgeWorkspace removes only the target workspace mappings (uninstall)', () => {
    const svc = new AnonymizationService();
    (svc as unknown as { anonymizationData: AnonymizationData }).anonymizationData = { anonymization: {} };
    svc.getAnonymizationMapping('U1', 'Alice Anderson', undefined, 'TWS_A');
    svc.getAnonymizationMapping('U2', 'Bob Brown', undefined, 'TWS_B');

    const removed = svc.purgeWorkspace('TWS_A');
    expect(removed).toBe(1);
    // TWS_A's name no longer de-anonymizes; TWS_B is intact.
    expect(svc.anonymizeText('met Alice Anderson', 'TWS_A')).toContain('Alice Anderson');
    expect(svc.anonymizeText('met Bob Brown', 'TWS_B')).not.toContain('Bob Brown');
  });
});
