/**
 * LLM configuration validation and management for OpenAI.
 */

export function validateOpenAIConfig(): boolean {
  const requiredVars = ['OPENAI_API_KEY'];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      console.error(`Missing required environment variable: ${varName}`);
      return false;
    }
  }

  console.info('OpenAI configuration is valid');
  return true;
}

export function getOpenAIConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    responsesModel: process.env.OPENAI_RESPONSES_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    queryExpansionModel: process.env.OPENAI_QUERY_EXPANSION_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    embeddingsModel: process.env.OPENAI_EMBEDDINGS_MODEL || 'text-embedding-3-small',
  };
}

export function isOpenAIEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export function getAIProvider(): 'openai' {
  return 'openai';
}

export function validateCurrentProvider(): boolean {
  return validateOpenAIConfig();
}
