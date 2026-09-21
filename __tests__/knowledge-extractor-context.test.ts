// What the knowledge extractor is told about the organization before it reads
// the conversation.
//
// The project description and the glossary block are the two pieces PF4 adds
// (docs/project-folders.md 4). They matter because they are what stops the same
// word meaning two things in two projects, so what is asserted is that they
// actually reach the user prompt, next to the organization description — and
// that a workspace with neither is left exactly as it was.

const createChatCompletion = jest.fn(async () => '# Retention\n\nRetention is 90 days.');

jest.mock('services/llm/completions', () => ({
  createChatCompletion: (...args: unknown[]) => createChatCompletion(...(args as [])),
}));

jest.mock('services/llm/content-language', () => ({
  getContentLanguagePolicy: jest.fn(async () => 'follow-conversation'),
  contentLanguageDirective: jest.fn(() => '- Write in the SAME language as the conversation.'),
}));

jest.mock('services/slack/conversation-history', () => ({
  processMessageHistory: jest.fn(async (messages: Array<{ text?: string }>) =>
    messages.map((message) => ({ role: 'user', content: message.text ?? '' })),
  ),
}));

jest.mock('services/common/name-cache', () => ({ anonymizeText: (text: string) => text }));

import { extractKnowledgeFromMessages } from 'services/llm/knowledge-extractor';

const messages = [{ text: 'We keep logs for 90 days now.', user: 'U1', ts: '1.1' }] as never;

/** The user turn is where the conversation and its context are assembled. */
const userPrompt = (): string => {
  const [chat] = createChatCompletion.mock.calls[0] as unknown as [Array<{ role: string; content: string }>];
  return chat.find((message) => message.role === 'user')?.content ?? '';
};

beforeEach(() => {
  jest.clearAllMocks();
  createChatCompletion.mockResolvedValue('# Retention\n\nRetention is 90 days.');
});

describe('the extraction prompt', () => {
  it('carries the project description beside the organization description', async () => {
    await extractKnowledgeFromMessages(
      messages,
      {
        organizationName: 'Acme Labs',
        organizationDescription: 'A research lab.',
        projectDescription: 'The experiment platform rebuild, H2 2026.',
      },
      undefined,
      'T1',
    );

    const prompt = userPrompt();
    expect(prompt).toContain('- Organization: Acme Labs');
    expect(prompt).toContain('- About: A research lab.');
    expect(prompt).toContain('- Project: The experiment platform rebuild, H2 2026.');
  });

  it('carries the glossary block as its own labelled section', async () => {
    await extractKnowledgeFromMessages(
      messages,
      {
        organizationName: 'Acme Labs',
        glossaryBlock: "These are the organization's own terms:\nRAG (retrieval): retrieval-augmented generation",
      },
      undefined,
      'T1',
    );

    const prompt = userPrompt();
    expect(prompt).toContain('**Glossary**:');
    expect(prompt).toContain('RAG (retrieval): retrieval-augmented generation');
  });

  it('adds nothing when there is no project and no glossary', async () => {
    await extractKnowledgeFromMessages(messages, { organizationName: 'Acme Labs' }, undefined, 'T1');

    const prompt = userPrompt();
    expect(prompt).toContain('- Organization: Acme Labs');
    expect(prompt).not.toContain('- Project:');
    expect(prompt).not.toContain('**Glossary**:');
  });

  it('still reaches the conversation itself', async () => {
    await extractKnowledgeFromMessages(messages, { projectDescription: 'Alpha.' }, undefined, 'T1');

    expect(userPrompt()).toContain('[1] We keep logs for 90 days now.');
  });
});
