// Reasoning models reject `temperature` unless reasoning effort is `none`. The
// wrapper has to pick the right knobs per model and, for a model it guesses
// wrong about, recover from the API's 400 instead of failing the user's action.

const mockCreate = jest.fn();
const mockResolve = jest.fn();
jest.mock('services/llm/openai-client-factory', () => ({
  getOpenAIClient: () => ({ responses: { create: mockCreate } }),
  invalidateClientCache: jest.fn(),
}));

jest.mock('services/llm/llm-config', () => ({
  resolveLLMConfig: (...args: unknown[]) => mockResolve(...args),
}));

jest.mock('services/common/name-cache', () => ({
  anonymizeText: (text: string) => text,
  deAnonymizeText: (text: string) => text,
}));

import { createChatCompletion } from 'services/llm/completions';
import { resetLearnedSamplingParams, samplingParamsFor } from 'services/llm/sampling-params';

const ok = { output_text: 'answer', status: 'completed', incomplete_details: null };

function unsupportedTemperature() {
  return Object.assign(new Error("400 Unsupported parameter: 'temperature' is not supported with this model."), {
    status: 400,
    param: 'temperature',
  });
}

beforeEach(() => {
  mockCreate.mockReset();
  mockResolve.mockReset();
  resetLearnedSamplingParams();
});

describe('samplingParamsFor', () => {
  it('keeps temperature and adds no reasoning for GPT-5 models', () => {
    expect(samplingParamsFor('gpt-5.4-mini', 0)).toEqual({ temperature: 0 });
  });

  it('runs GPT-6 Luna and Sol at effort none, where temperature is legal', () => {
    expect(samplingParamsFor('gpt-6-luna', 0)).toEqual({ temperature: 0, reasoning: { effort: 'none' } });
    expect(samplingParamsFor('gpt-6-sol', 0)).toEqual({ temperature: 0, reasoning: { effort: 'none' } });
  });

  it('runs GPT-6 Astra and GPT-6.1 Sol at effort low, without temperature', () => {
    expect(samplingParamsFor('gpt-6-astra', 0)).toEqual({ reasoning: { effort: 'low' } });
    expect(samplingParamsFor('gpt-6.1-sol', 0)).toEqual({ reasoning: { effort: 'low' } });
  });
});

describe('createChatCompletion temperature fallback', () => {
  it('retries without temperature when the model rejects it, and remembers the model', async () => {
    mockResolve.mockResolvedValue({ apiKey: 'sk-test', model: 'gpt-5-pro' });
    mockCreate.mockRejectedValueOnce(unsupportedTemperature()).mockResolvedValue(ok);

    await expect(createChatCompletion([{ role: 'user', content: 'hi' }], { temperature: 0 })).resolves.toBe('answer');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0]).toHaveProperty('temperature', 0);
    expect(mockCreate.mock.calls[1][0]).not.toHaveProperty('temperature');

    await createChatCompletion([{ role: 'user', content: 'again' }], { temperature: 0 });
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[2][0]).not.toHaveProperty('temperature');
  });

  it('does not retry other 400s', async () => {
    mockResolve.mockResolvedValue({ apiKey: 'sk-test', model: 'gpt-5.4-mini' });
    mockCreate.mockRejectedValue(Object.assign(new Error('400 Invalid input'), { status: 400, param: 'input' }));

    await expect(createChatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow('Invalid input');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('sends reasoning effort none with temperature for GPT-6 Luna', async () => {
    mockResolve.mockResolvedValue({ apiKey: 'sk-test', model: 'gpt-6-luna' });
    mockCreate.mockResolvedValue(ok);

    await createChatCompletion([{ role: 'user', content: 'hi' }], { temperature: 0 });
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ temperature: 0, reasoning: { effort: 'none' } });
  });
});
