import OpenAI from 'openai';

interface CatalogEntry {
  models: string[];
  expiresAt: number;
}

const catalogCache = new Map<string, CatalogEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// Curated fallback used when we cannot reach the OpenAI catalog (e.g. before a
// workspace has provided a valid key). Listed newest → oldest so the dropdown
// surfaces the current frontier first.
export const CURATED_GPT5_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'];

function isSelectableGpt5Model(id: string): boolean {
  if (!id.startsWith('gpt-5')) return false;
  // Exclude non-text capabilities surfaced under the gpt-5 family.
  if (/(audio|realtime|image|tts|whisper|embedding|moderation)/.test(id)) return false;
  return true;
}

// Sort newest version first, then by name within the same version, so the
// dropdown leads with the current frontier rather than alphabetical "gpt-5".
function compareModelIds(a: string, b: string): number {
  if (a === b) return 0;
  return b.localeCompare(a, undefined, { numeric: true });
}

export async function listGpt5Models(apiKey: string): Promise<string[]> {
  const cached = catalogCache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.models.list();
    const models = response.data
      .map((m) => m.id)
      .filter(isSelectableGpt5Model)
      .sort(compareModelIds);
    const deduped = Array.from(new Set(models));
    catalogCache.set(apiKey, { models: deduped, expiresAt: Date.now() + CACHE_TTL_MS });
    return deduped;
  } catch {
    return CURATED_GPT5_MODELS;
  }
}

export function invalidateModelCatalog(apiKey: string): void {
  catalogCache.delete(apiKey);
}
