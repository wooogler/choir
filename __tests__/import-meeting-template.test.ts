import type { MeetingMeta } from 'services/import/sources/meeting/meta';
import { emptyMeetingSections, renderMeetingNote } from 'services/import/sources/meeting/template';

/**
 * The template produces committed text, so it is checked the way committed text
 * has to be: the exact shape the design draws (docs/meeting-notes-and-glossary.md,
 * 산출물), the metadata table as the manager typed it and not as a model imagined
 * it, and both languages — a Korean workspace's note with English headings would
 * be a document nobody in it can skim.
 */

const META: MeetingMeta = {
  title: '주간 동기화 회의',
  date: '2026-09-20',
  folder: 'meetings',
  fileName: '2026-09-20-weekly.md',
  participants: ['이상욱', '김민지', '박준호'],
  context: 'CHOIR 주간 회의',
  format: 'notes',
};

const SECTIONS = {
  summary: ['인덱스 재생성 주기를 매일로 바꿨다.'],
  decisions: ['야간 재생성을 기본으로 한다.'],
  actionItems: [
    { task: '스테이징 캐시 재예열', owner: '김민지', due: '2026-09-22' },
    { task: '문서 갱신', owner: '박준호' },
  ],
  discussion: [{ topic: '검색 품질', points: ['예전 답이 남아 있었다.', '캐시가 원인이었다.'] }],
  fullRecord: '**이상욱**: 시작하겠습니다.\n\n**김민지**: 어제 올렸습니다.',
};

describe('renderMeetingNote: 회의록', () => {
  const note = renderMeetingNote({ meta: META, language: 'ko', sections: SECTIONS });

  it("opens with the title and the manager's own metadata table", () => {
    expect(note.startsWith('# 주간 동기화 회의\n')).toBe(true);
    expect(note).toContain(
      '| 날짜 | 참석자 | 관련 |\n| --- | --- | --- |\n| 2026-09-20 | 이상욱, 김민지, 박준호 | CHOIR 주간 회의 |',
    );
  });

  it('carries no source note — the commit adds that', () => {
    expect(note).not.toContain('choir:source');
    expect(note).not.toContain('출처:');
  });

  it('lays the five sections out in the order the design draws them', () => {
    const headings = [...note.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(['요약', '결정 사항', '할 일', '논의', '전체 기록']);
  });

  it('writes the action items as a table with plain names in it', () => {
    expect(note).toContain('| 할 일 | 담당 | 기한 |');
    expect(note).toContain('| 스테이징 캐시 재예열 | 김민지 | 2026-09-22 |');
    // No owner and no due date is an empty cell, not a missing column.
    expect(note).toContain('| 문서 갱신 | 박준호 |  |');
  });

  it('makes each discussion topic a subheading of 논의', () => {
    expect(note).toContain('### 검색 품질');
    expect(note).toContain('- 예전 답이 남아 있었다.');
  });

  it('ends with the cleaned record', () => {
    expect(note.trimEnd().endsWith('**김민지**: 어제 올렸습니다.')).toBe(true);
    expect(note.endsWith('\n')).toBe(true);
  });
});

describe('renderMeetingNote: English', () => {
  it('uses the English catalog for every heading and label', () => {
    const note = renderMeetingNote({
      meta: { ...META, title: 'Weekly sync', participants: ['Sangwook Lee'], context: 'CHOIR weekly' },
      language: 'en',
      sections: SECTIONS,
    });

    expect([...note.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual([
      'Summary',
      'Decisions',
      'Action items',
      'Discussion',
      'Full record',
    ]);
    expect(note).toContain('| Date | Participants | Related |');
    expect(note).toContain('| Task | Owner | Due |');
  });
});

describe('renderMeetingNote: 정리된 transcript', () => {
  it('is the same document with the analysis left out', () => {
    const note = renderMeetingNote({
      meta: { ...META, format: 'transcript' },
      language: 'ko',
      sections: SECTIONS,
    });

    expect([...note.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual(['전체 기록']);
    expect(note).toContain('| 날짜 | 참석자 | 관련 |');
    expect(note).toContain('**이상욱**: 시작하겠습니다.');
  });
});

describe('renderMeetingNote: empty sections', () => {
  it('says 없음 rather than leaving a heading with nothing under it', () => {
    const note = renderMeetingNote({ meta: META, language: 'ko', sections: emptyMeetingSections('**이상욱**: …') });
    // 요약, 결정 사항, 할 일, 논의 — four sections with nothing in them.
    expect(note.match(/^없음$/gm)).toHaveLength(4);
    // An empty action table would render as nothing at all in most viewers.
    expect(note).not.toContain('| 할 일 | 담당 | 기한 |');
  });

  it('says None in English', () => {
    const note = renderMeetingNote({ meta: META, language: 'en', sections: emptyMeetingSections('**Lee**: …') });
    expect(note.match(/^None$/gm)).toHaveLength(4);
  });

  it('leaves the 관련 cell empty when the manager gave no context', () => {
    const note = renderMeetingNote({
      meta: { ...META, context: undefined },
      language: 'ko',
      sections: SECTIONS,
    });
    expect(note).toContain('| 2026-09-20 | 이상욱, 김민지, 박준호 |  |');
  });
});

describe('renderMeetingNote: table safety', () => {
  it('escapes a pipe so one name cannot split the row', () => {
    const note = renderMeetingNote({
      meta: { ...META, participants: ['Lee | Sangwook'] },
      language: 'en',
      sections: SECTIONS,
    });
    expect(note).toContain('| Lee \\| Sangwook |');
  });
});
