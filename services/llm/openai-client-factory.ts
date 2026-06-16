import OpenAI from 'openai';

const clientCache = new Map<string, OpenAI>();

export function getOpenAIClient(apiKey: string): OpenAI {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new OpenAI({ apiKey });
    clientCache.set(apiKey, client);
  }
  return client;
}

export function invalidateClientCache(apiKey: string): void {
  clientCache.delete(apiKey);
}

export async function validateOpenAIKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, error: 'API key is empty.' };
  }
  try {
    const probe = new OpenAI({ apiKey });
    await probe.models.list();
    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { valid: false, error: message };
  }
}
