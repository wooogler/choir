import type { LocaleCatalog } from '../../types';

/**
 * Korean for the imported document's source line.
 *
 * Document text, not bot chat, so this is 문어체 — a caption a reader skims on
 * the way into the document, not a sentence the bot says to them.
 */
export const importStrings: LocaleCatalog = {
  'import.sourceNote.url': '출처: {url} ({date} 가져옴)',
  'import.sourceNote.file': '출처: {name} ({date} 가져옴)',
  'import.sourceNote.fileWithPages': '출처: {name} ({pages}, {date} 가져옴)',
  'import.sourceNote.googleDoc': '출처: Google 문서 {name} ({date} 가져옴)',
  'import.sourceNote.pages': { other: '{count}쪽' },
  'import.sourceNote.fileWithDetail': '출처: {name} ({detail}, {date} 가져옴)',
  'import.sourceNote.minutes': { other: '{count}분' },
  'import.sourceNote.speakers': { other: '화자 {count}명' },

  // 회의록 템플릿 (services/import/sources/meeting/template.ts). 문서에 그대로
  // 커밋되는 제목·표 머리글이므로 출처 줄과 같은 콘텐츠 언어 규칙을 따른다.
  'meeting.section.summary': '요약',
  'meeting.section.decisions': '결정 사항',
  'meeting.section.actionItems': '할 일',
  'meeting.section.discussion': '논의',
  'meeting.section.fullRecord': '전체 기록',
  'meeting.section.date': '날짜',
  'meeting.section.participants': '참석자',
  'meeting.section.related': '관련',
  'meeting.section.actionTask': '할 일',
  'meeting.section.actionOwner': '담당',
  'meeting.section.actionDue': '기한',
  'meeting.section.none': '없음',
};
