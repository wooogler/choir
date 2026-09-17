// Keep generated output in one language: prompts pin the output language, and
// hardcoded fallbacks follow the asker's / the knowledge's language.

const mockChat = jest.fn();
const mockStructured = jest.fn();
jest.mock('services/llm/completions', () => ({
  createChatCompletion: (...args: any[]) => mockChat(...args),
  createStructuredResponse: (...args: any[]) => mockStructured(...args),
}));

// document-editor anonymizes knowledge before prompting; not under test here.
jest.mock('services/common/name-cache', () => ({
  anonymizeText: (text: string) => text,
}));

const mockVisionCreate = jest.fn();
jest.mock('services/llm/openai-client-factory', () => ({
  getOpenAIClient: () => ({ responses: { create: mockVisionCreate } }),
  invalidateClientCache: jest.fn(),
}));
jest.mock('services/llm/llm-config', () => ({
  resolveLLMConfig: async () => ({ apiKey: 'sk-test', model: 'vision-test' }),
}));

// The workspace's content-language policy; unset workspaces (most of this file)
// never reach it.
const mockContentLanguage = jest.fn();
jest.mock('services/i18n/resolve-locale', () => ({
  resolveContentLanguage: (...args: any[]) => mockContentLanguage(...args),
}));

import { detectDocumentLanguage, detectLanguage } from 'services/common/language';
import { respondToGeneralConversation } from 'services/llm/chat-responder';
import { createNewSectionFromKnowledge, generateNewFileDefaults } from 'services/llm/content-generator';
import { editMarkdownWithKnowledge } from 'services/llm/document-editor';
import { fallbackMessage } from 'services/llm/fallback-messages';
import { answerQuestion } from 'services/llm/qa-service';
import { generateImageCaption } from 'services/llm/vision-caption';

const KOREAN_QUESTION = '연차 휴가는 며칠인가요?';

beforeEach(() => {
  mockChat.mockReset();
  mockStructured.mockReset();
  mockVisionCreate.mockReset();
  mockContentLanguage.mockReset();
  mockContentLanguage.mockResolvedValue('follow-conversation');
});

describe('detectLanguage', () => {
  it('detects Hangul as Korean', () => {
    expect(detectLanguage(KOREAN_QUESTION)).toBe('ko');
    expect(detectLanguage('ㅎㅇ')).toBe('ko');
  });

  it('detects kana as Japanese even when kanji are mixed in', () => {
    expect(detectLanguage('休暇は何日ですか')).toBe('ja');
  });

  it('detects bare Han as Chinese', () => {
    expect(detectLanguage('年假有几天')).toBe('zh');
  });

  it('defaults to English for latin text, empty strings and nullish input', () => {
    expect(detectLanguage('How many vacation days do we get?')).toBe('en');
    expect(detectLanguage('')).toBe('en');
    expect(detectLanguage(undefined)).toBe('en');
    expect(detectLanguage(null)).toBe('en');
  });
});

describe('detectDocumentLanguage', () => {
  it('stays English when an English document quotes a single Korean word', () => {
    const doc = `# Vacation policy

Every employee gets fifteen days of paid leave per year. Requests go through the
HR portal and need a manager's approval at least three business days ahead.
The Korean-language handbook calls this 연차.`;
    expect(detectDocumentLanguage(doc)).toBe('en');
  });

  it('stays Korean for a Korean document full of English terms and URLs', () => {
    const doc = `# 배포 가이드

배포는 GitHub Actions workflow 에서 실행됩니다. 자세한 내용은
[deployment runbook](https://github.com/example/choir/blob/main/docs/deployment.md) 을 참고하세요.
스테이징 환경은 https://staging.example.com 이며, PM2 프로세스 이름은 choir-staging 입니다.
![architecture diagram](../images/architecture-overview.png)`;
    expect(detectDocumentLanguage(doc)).toBe('ko');
  });

  it('stays Korean for a code-heavy Korean document', () => {
    const doc = `# 설정

아래 명령으로 설치합니다.

\`\`\`bash
pnpm install
pnpm build
CHOIR_DATA_DIR=/var/lib/choir node dist/app.js --verbose --socket-mode
\`\`\`

환경 변수 \`SLACK_BOT_TOKEN\` 과 \`OPENAI_API_KEY\` 가 필요합니다.`;
    expect(detectDocumentLanguage(doc)).toBe('ko');
  });

  it('defaults to English for an empty or content-free document', () => {
    expect(detectDocumentLanguage('')).toBe('en');
    expect(detectDocumentLanguage('# 123\n\n- 456\n')).toBe('en');
    expect(detectDocumentLanguage(undefined)).toBe('en');
  });
});

describe('fallbackMessage', () => {
  it('substitutes placeholders', () => {
    expect(fallbackMessage('chat.greeting', 'en', { userName: 'Sam', organizationName: 'Acme' })).toContain('*Sam*');
    expect(fallbackMessage('chat.greeting', 'en', { userName: 'Sam', organizationName: 'Acme' })).toContain('Acme');
  });

  it('keeps the English wording byte-identical to the previous hardcoded strings', () => {
    expect(fallbackMessage('qa.noAnswer', 'en')).toBe(
      "I couldn't find this information in our current documentation. Could you help by asking others or starting a discussion about this topic?",
    );
    expect(fallbackMessage('doc.newDocumentTitle', 'en')).toBe('New Document');
    expect(fallbackMessage('doc.newSectionTitle', 'en')).toBe('New Section');
  });

  it('returns Korean for ko and falls back to English for languages without a translation', () => {
    expect(fallbackMessage('doc.newSectionTitle', 'ko')).toBe('새 섹션');
    expect(fallbackMessage('doc.newSectionTitle', 'ja')).toBe('New Section');
    expect(fallbackMessage('doc.newSectionTitle', 'zh')).toBe('New Section');
  });
});

describe('document-editor prompts pin the output language', () => {
  const systemPrompt = () => mockChat.mock.calls[0][0][0].content as string;

  it('tells the model to follow the knowledge (or the document) when filling an empty section', async () => {
    mockChat.mockResolvedValue('생성된 내용');
    await editMarkdownWithKnowledge('', '연차는 15일입니다', { fileName: 'hr.md', sectionName: '휴가' });

    expect(systemPrompt()).toContain(
      '- Write in the same language as the knowledge, unless the FILE/SECTION context is clearly in another language, in which case match the document',
    );
  });

  it('makes the existing content win when merging, with no mixed-language output', async () => {
    mockChat.mockResolvedValue('merged');
    await editMarkdownWithKnowledge('- Vacation is 14 days', '연차는 15일입니다', { fileName: 'hr.md' });

    expect(systemPrompt()).toContain(
      "- Write the result in the language of the EXISTING content. If the knowledge is in a different language, translate it faithfully into the existing content's language; never leave mixed-language output",
    );
  });
});

describe('a configured content language overrides the input language', () => {
  const systemPrompt = () => mockChat.mock.calls[0][0][0].content as string;
  const structuredPrompt = () => mockStructured.mock.calls[0][0][0].content as string;

  beforeEach(() => {
    mockContentLanguage.mockResolvedValue('ko');
  });

  it('pins an empty section to the configured language', async () => {
    mockChat.mockResolvedValue('생성된 내용');
    await editMarkdownWithKnowledge('', 'Vacation is 15 days', { fileName: 'hr.md' }, 'T1');

    expect(mockContentLanguage).toHaveBeenCalledWith('T1');
    expect(systemPrompt()).toContain(
      '- Write the output in Korean, regardless of the language of the knowledge. Keep quoted names, URLs and code verbatim.',
    );
    expect(systemPrompt()).not.toContain('FILE/SECTION context is clearly in another language');
  });

  it('keeps matching existing content, and converts content in another language when merging', async () => {
    mockChat.mockResolvedValue('merged');
    await editMarkdownWithKnowledge('- Vacation is 14 days', '연차는 15일입니다', { fileName: 'hr.md' }, 'T1');

    expect(systemPrompt()).toContain('If the EXISTING content is already in Korean, keep its wording and style');
    expect(systemPrompt()).toContain('write the merged result in Korean');
  });

  it('pins a new file to the configured language while the file name stays English', async () => {
    mockStructured.mockResolvedValue({ fileName: 'vacation-policy.md', initialContent: '# 연차' });
    await generateNewFileDefaults('Vacation is 15 days', [], 'T1');

    expect(structuredPrompt()).toContain(
      '- Write the initial content in Korean, regardless of the language of the knowledge.',
    );
    expect(structuredPrompt()).toContain('the file name stays in English');
  });

  it('pins a new section to the configured language', async () => {
    mockStructured.mockResolvedValue({
      sectionTitle: '연차',
      sectionContent: '- 15일',
      recommendedFile: 'hr.md',
      reasoning: 'why',
    });
    await createNewSectionFromKnowledge('Vacation is 15 days', [], 'T1');

    expect(structuredPrompt()).toContain(
      '- Write the section title and content in Korean, regardless of the language of the knowledge.',
    );
  });
});

describe('vision captions follow the document language', () => {
  const promptText = () => mockVisionCreate.mock.calls[0][0].input[0].content[0].text as string;

  it('asks for the caption in the hinted language', async () => {
    mockVisionCreate.mockResolvedValue({ output_text: '다이어그램\n\n설명' });
    await generateImageCaption({ workspaceId: 'W1', dataUrl: 'data:image/png;base64,AA', documentLanguage: 'ko' });

    expect(promptText()).toContain('Write the caption and the description in Korean');
  });

  it('defaults to English when no hint is available', async () => {
    mockVisionCreate.mockResolvedValue({ output_text: 'A diagram\n\nDetails' });
    await generateImageCaption({ workspaceId: 'W1', dataUrl: 'data:image/png;base64,AA' });

    expect(promptText()).toContain('Write the caption and the description in English');
  });
});

describe('fallback strings follow the asker / the knowledge', () => {
  it('answers a Korean question in Korean when the QA model call fails', async () => {
    mockStructured.mockRejectedValue(new Error('boom'));
    const korean = await answerQuestion(KOREAN_QUESTION, [], []);
    expect(korean.canAnswer).toBe(false);
    expect(korean.response).toBe(fallbackMessage('qa.noAnswer', 'ko'));

    const english = await answerQuestion('How many vacation days?', [], []);
    expect(english.response).toBe(
      "I couldn't find this information in our current documentation. Could you help by asking others or starting a discussion about this topic?",
    );
  });

  it('replies in Korean when the chat model call fails on a Korean message', async () => {
    mockChat.mockRejectedValue(new Error('boom'));
    const reply = await respondToGeneralConversation(KOREAN_QUESTION, 'Sam', 'Acme');
    expect(reply).toBe(fallbackMessage('chat.error', 'ko', { userName: 'Sam', organizationName: 'Acme' }));
  });

  it('takes the canned fast path for a Korean greeting, in Korean', async () => {
    const reply = await respondToGeneralConversation('안녕하세요', 'Sam', 'Acme');
    expect(reply).toBe(fallbackMessage('chat.greeting', 'ko', { userName: 'Sam', organizationName: 'Acme' }));
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('takes the canned fast path for Korean thanks, in Korean', async () => {
    const reply = await respondToGeneralConversation('감사합니다!', 'Sam', 'Acme');
    expect(reply).toBe(fallbackMessage('chat.thanks', 'ko', { userName: 'Sam', organizationName: 'Acme' }));
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('keeps the English greeting unchanged', async () => {
    const reply = await respondToGeneralConversation('hello there', 'Sam', 'Acme');
    expect(reply).toBe(
      "Hi *Sam*! 👋 I'm CHOIR, your friendly documentation assistant. Is there a specific document you're looking for about Acme, or perhaps some information you'd like to update or add?",
    );
  });

  it('titles a failed new-file suggestion in the knowledge language, keeping the file name English', async () => {
    mockStructured.mockRejectedValue(new Error('boom'));
    const defaults = await generateNewFileDefaults('연차는 15일입니다', []);
    expect(defaults.fileName).toBe('new-document.md');
    expect(defaults.initialContent.startsWith('# 새 문서')).toBe(true);

    const english = await generateNewFileDefaults('Vacation is 15 days', []);
    expect(english.initialContent.startsWith('# New Document')).toBe(true);
  });

  it('titles a failed new-section suggestion in the knowledge language', async () => {
    mockStructured.mockRejectedValue(new Error('boom'));
    const suggestion = await createNewSectionFromKnowledge('연차는 15일입니다', []);
    expect(suggestion.sectionTitle).toBe('새 섹션');

    const english = await createNewSectionFromKnowledge('Vacation is 15 days', []);
    expect(english.sectionTitle).toBe('New Section');
  });
});
