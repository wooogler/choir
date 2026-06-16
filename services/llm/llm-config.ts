/**
 * LLM configuration validation and per-workspace resolution for OpenAI.
 */

import { WorkspaceStore } from 'services/workspace/workspace-store';

export type LLMPurpose = 'qa' | 'document-update' | 'classification';

// Classification model is intentionally fixed to keep intent routing cheap and
// consistent across workspaces. Managers cannot change it from App Home.
export const CLASSIFICATION_MODEL = 'gpt-5.4-nano-2026-03-17';

const DEFAULT_MODEL = 'gpt-5-mini';

export function validateOpenAIConfig(): boolean {
  if (!process.env.OPENAI_API_KEY) {
    console.warn(
      'OPENAI_API_KEY environment variable is not set. Workspaces must configure their own key from App Home.',
    );
  }
  return true;
}

export function getOpenAIConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
    responsesModel: process.env.OPENAI_RESPONSES_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL,
    queryExpansionModel: process.env.OPENAI_QUERY_EXPANSION_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL,
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

interface ResolvedLLMConfig {
  apiKey: string;
  model: string;
  source: 'workspace' | 'env';
}

export async function resolveLLMConfig(
  workspaceId: string | undefined,
  purpose: LLMPurpose,
): Promise<ResolvedLLMConfig> {
  const envConfig = getOpenAIConfig();
  const envFallbackModel = envConfig.responsesModel;

  if (purpose === 'classification') {
    const apiKey = (await readWorkspaceApiKey(workspaceId)) || envConfig.apiKey;
    if (!apiKey) {
      throw new Error('No OpenAI API key configured. Set it from App Home or via OPENAI_API_KEY.');
    }
    return {
      apiKey,
      model: CLASSIFICATION_MODEL,
      source: apiKey === envConfig.apiKey ? 'env' : 'workspace',
    };
  }

  const wsSettings = workspaceId ? await new WorkspaceStore().getOpenAISettings(workspaceId) : undefined;
  const apiKey = wsSettings?.apiKey || envConfig.apiKey;
  if (!apiKey) {
    throw new Error('No OpenAI API key configured. Set it from App Home or via OPENAI_API_KEY.');
  }

  const wsModel = purpose === 'qa' ? wsSettings?.qaModel : wsSettings?.documentUpdateModel;
  const model = wsModel || envFallbackModel;

  return {
    apiKey,
    model,
    source: wsSettings?.apiKey ? 'workspace' : 'env',
  };
}

async function readWorkspaceApiKey(workspaceId: string | undefined): Promise<string | undefined> {
  if (!workspaceId) return undefined;
  const settings = await new WorkspaceStore().getOpenAISettings(workspaceId);
  return settings?.apiKey;
}
