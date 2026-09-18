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
};
