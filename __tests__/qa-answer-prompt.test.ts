/**
 * What the project folder adds to the answer prompt, and what it must not
 * change when there is no project.
 */

const mockStructured = jest.fn();
jest.mock('services/llm/completions', () => ({
  createStructuredResponse: (...args: any[]) => mockStructured(...args),
}));

jest.mock('services/slack', () => ({
  getUserName: async () => 'Sangwook',
}));

jest.mock('services/slack/conversation-history', () => ({
  processMessageHistory: async () => [],
}));

import { answerQuestion } from 'services/llm/qa-service';
import { createT } from '../src/i18n';

/** The user turn of the prompt, which is where the context is assembled. */
function promptOf(call: unknown[]): string {
  const messages = call[0] as Array<{ role: string; content: string }>;
  return messages.find((message) => message.role === 'user')?.content ?? '';
}

beforeEach(() => {
  mockStructured.mockReset();
  mockStructured.mockResolvedValue({ canAnswer: true, response: 'Three days.' });
});

const docs = [{ pageContent: 'Trials run for three days.', metadata: { fileName: 'projects/alpha/trials.md' } }];

describe('answerQuestion with a project', () => {
  it("lists the project's description next to the organization's", async () => {
    await answerQuestion('q', [], docs, undefined, 'Acme HQ', 'Acme', 'We build platforms.', 'T1', {
      projectDescription: 'The experiment platform redesign.',
    });

    const prompt = promptOf(mockStructured.mock.calls[0]);
    expect(prompt).toContain('- About: We build platforms.');
    expect(prompt).toContain('- Project: The experiment platform redesign.');
  });

  it('puts the glossary above the references, so the terms are read before the text using them', async () => {
    await answerQuestion('q', [], docs, undefined, 'Acme HQ', 'Acme', 'We build platforms.', 'T1', {
      glossaryBlock: 'Rollout: shipping a build to users.',
    });

    const prompt = promptOf(mockStructured.mock.calls[0]);
    expect(prompt).toContain('==== GLOSSARY ====');
    expect(prompt).toContain('Rollout: shipping a build to users.');
    expect(prompt.indexOf('==== GLOSSARY ====')).toBeLessThan(prompt.indexOf('==== REFERENCES ===='));
  });
});

describe('answerQuestion without a project', () => {
  it('builds the same prompt whether the context argument is absent or empty', async () => {
    await answerQuestion('q', [], docs, undefined, 'Acme HQ', 'Acme', 'We build platforms.', 'T1');
    await answerQuestion('q', [], docs, undefined, 'Acme HQ', 'Acme', 'We build platforms.', 'T1', {});

    const [first, second] = mockStructured.mock.calls.map(promptOf);
    expect(second).toBe(first);
    expect(first).not.toContain('GLOSSARY');
    expect(first).not.toContain('- Project:');
  });
});

describe('the widened-scope sentence', () => {
  it('is translated for the reader', () => {
    expect(createT('en')('qa.scope.widened')).toContain('all of the documentation');
    expect(createT('ko')('qa.scope.widened')).toContain('전체 문서');
  });
});
