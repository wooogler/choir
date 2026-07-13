import * as os from 'node:os';
import * as path from 'node:path';

// Isolate the on-disk cache the service writes to before importing it.
process.env.CHOIR_DATA_DIR = path.join(os.tmpdir(), 'choir-anon-test');

import { type AnonymizationData, AnonymizationService } from '../services/anonymization/anonymization-service';

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
});
