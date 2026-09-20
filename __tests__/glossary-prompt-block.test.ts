import type { GlossaryEntry } from '../services/glossary/parse';
import { estimateTokens, glossaryPromptBlock, mentions } from '../services/glossary/prompt-block';

/**
 * This block is paid for on every chunk of every conversion, so the two things
 * worth testing are the two that cost money: it stays under the cap, and when
 * the cap forces a choice it keeps the terms the page actually uses.
 */

function entry(term: string, aliases: string[] = [], description = ''): GlossaryEntry {
  return { term, aliases, description, file: 'GLOSSARY.md' };
}

const CHOIR = entry('CHOIR', ['코이어', '콰이어'], '이 프로젝트. Slack 지식 봇');
const QMD = entry('QMD', ['큐엠디'], '로컬 검색 인덱스');
const RAG = entry('RAG', ['래그'], 'Retrieval-Augmented Generation');

describe('estimateTokens', () => {
  it('counts Hangul-heavy text at 3 characters per token and the rest at 4', () => {
    expect(estimateTokens('가나다라라바사아자차카타파하')).toBe(Math.ceil(14 / 3));
    expect(estimateTokens('abcdefgh')).toBe(2);
    // A Korean sentence with English terms in it is still Korean.
    expect(estimateTokens('CHOIR는 슬랙에서 문서를 찾아주는 봇이다')).toBe(Math.ceil(24 / 3));
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
  });
});

describe('glossaryPromptBlock', () => {
  it('is empty when there is nothing to say', () => {
    expect(glossaryPromptBlock([])).toBe('');
  });

  it('writes one line per entry, with the aliases in parentheses', () => {
    const block = glossaryPromptBlock([CHOIR, RAG]);
    const lines = block.split('\n');

    expect(lines[0]).toContain("organization's own terms");
    expect(lines[1]).toBe('CHOIR (코이어, 콰이어): 이 프로젝트. Slack 지식 봇');
    expect(lines[2]).toBe('RAG (래그): Retrieval-Augmented Generation');
  });

  it('drops the empty parts of a sparse entry', () => {
    expect(glossaryPromptBlock([entry('QMD')]).split('\n')[1]).toBe('QMD');
    expect(glossaryPromptBlock([entry('QMD', [], 'The index')]).split('\n')[1]).toBe('QMD: The index');
    expect(glossaryPromptBlock([entry('QMD', ['큐엠디'])]).split('\n')[1]).toBe('QMD (큐엠디)');
  });

  it('gives the instruction in the language asked for', () => {
    expect(glossaryPromptBlock([CHOIR], { language: 'ko' }).split('\n')[0]).toContain('정식 표기');
    expect(glossaryPromptBlock([CHOIR], { language: 'en' }).split('\n')[0]).toContain('canonical form');
  });

  it('keeps the whole glossary when it fits', () => {
    const block = glossaryPromptBlock([CHOIR, QMD, RAG], { maxTokens: 1500 });
    expect(block.split('\n')).toHaveLength(4);
    expect(estimateTokens(block)).toBeLessThanOrEqual(1500);
  });

  it('keeps the terms the text mentions when the cap bites, and stays under it', () => {
    const filler = Array.from({ length: 200 }, (_, index) =>
      entry(`TERM${index}`, [`alias${index}`], `Description number ${index} of a term nobody used.`),
    );
    const entries = [...filler.slice(0, 100), CHOIR, RAG, ...filler.slice(100)];

    const block = glossaryPromptBlock(entries, {
      text: '오늘 코이어 배포 회의. We also reviewed the RAG pipeline.',
      maxTokens: 200,
    });

    expect(estimateTokens(block)).toBeLessThanOrEqual(200);
    const lines = block.split('\n');
    // The two mentioned entries come first, ahead of a hundred fillers that
    // were declared before them.
    expect(lines[1]).toBe('CHOIR (코이어, 콰이어): 이 프로젝트. Slack 지식 봇');
    expect(lines[2]).toBe('RAG (래그): Retrieval-Augmented Generation');
    expect(lines.length).toBeLessThan(entries.length);
  });

  it('matches a Latin term on word boundaries and a Hangul alias as a substring', () => {
    // "storage" must not count as a mention of RAG.
    expect(mentions(RAG, 'We discussed storage and nothing else.')).toBe(false);
    expect(mentions(RAG, 'The rag pipeline is slow.')).toBe(true);
    expect(mentions(RAG, 'We reviewed RAG, then left.')).toBe(true);
    // Korean glues particles onto the noun: 코이어를 is a mention of 코이어.
    expect(mentions(CHOIR, '코이어를 다시 배포했다.')).toBe(true);
    expect(mentions(CHOIR, '오늘은 배포가 없었다.')).toBe(false);
    expect(mentions(QMD, '')).toBe(false);
  });

  it('orders a mentioned entry ahead of one the text never uses', () => {
    // Room for the instruction and one entry, with CHOIR declared second.
    const block = glossaryPromptBlock([RAG, CHOIR], { text: '코이어 배포 회의', maxTokens: 52 });

    expect(block.split('\n')).toEqual([
      expect.stringContaining('canonical form'),
      'CHOIR (코이어, 콰이어): 이 프로젝트. Slack 지식 봇',
    ]);
  });

  it('cuts in order when it has no text to judge relevance by', () => {
    const entries = Array.from({ length: 50 }, (_, index) => entry(`TERM${index}`, [], `Description ${index}`));
    const block = glossaryPromptBlock(entries, { maxTokens: 60 });

    expect(estimateTokens(block)).toBeLessThanOrEqual(60);
    expect(block.split('\n')[1]).toBe('TERM0: Description 0');
  });

  it('says nothing rather than instructing with no terms under it', () => {
    expect(glossaryPromptBlock([CHOIR, RAG], { maxTokens: 1 })).toBe('');
  });
});
