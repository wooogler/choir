import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock the OpenAI client so no network call happens and we control the model output.
const mockCreate = jest.fn();
jest.mock('services/llm/openai-client-factory', () => ({
  getOpenAIClient: () => ({ responses: { create: mockCreate } }),
  invalidateClientCache: jest.fn(),
}));

import { getAnonymizationMapping } from 'services/common/name-cache';
import { closeDatabase } from 'services/db/connection';
import { createChatCompletion } from 'services/llm/completions';

const WS = 'W-anon';

describe('createChatCompletion — skipAnonymization', () => {
  let tempDir: string;

  beforeEach(() => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-anon-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DATA_DIR = tempDir;
    process.env.OPENAI_API_KEY = 'sk-test';
    mockCreate.mockReset();
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
    Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
  });

  it('de-anonymizes the model output by default (restores real names)', async () => {
    const mapping = getAnonymizationMapping('U1', 'Alice', undefined, WS);
    mockCreate.mockResolvedValue({ output_text: `Ask ${mapping.fakeNickname} for details` });

    const out = await createChatCompletion([{ role: 'user', content: 'hi' }], { workspaceId: WS });
    expect(out).toBe('Ask Alice for details'); // pseudonym restored to the real name
  });

  it('does NOT de-anonymize when skipAnonymization is set (pseudonym is preserved)', async () => {
    const mapping = getAnonymizationMapping('U1', 'Alice', undefined, WS);
    mockCreate.mockResolvedValue({ output_text: `Ask ${mapping.fakeNickname} for details` });

    const out = await createChatCompletion([{ role: 'user', content: 'hi' }], {
      workspaceId: WS,
      skipAnonymization: true,
    });
    expect(out).toBe(`Ask ${mapping.fakeNickname} for details`); // NOT restored
    expect(out).not.toContain('Alice'); // the redline the dashboard paraphrase depends on
  });
});
