import { getOpenAIConfig, resolveLLMConfig } from 'services/llm/llm-config';
import { getOpenAIClient } from 'services/llm/openai-client-factory';

/**
 * Embeds a batch of strings, returning vectors in the SAME order as `inputs`.
 * Uses the workspace's API key (falling back to env) but the env-global embeddings
 * model (there is no per-workspace embeddings model). Throws if no key is
 * configured or the request fails — callers in the batch job wrap per-workspace.
 */
export async function embedBatch(workspaceId: string, inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];

  // resolveLLMConfig returns the QA *chat* model; we use it only for the API key.
  const resolved = await resolveLLMConfig(workspaceId, 'qa');
  const client = getOpenAIClient(resolved.apiKey);
  const model = getOpenAIConfig().embeddingsModel;

  const response = await client.embeddings.create({ model, input: inputs });
  return response.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/** Cosine similarity of two equal-length vectors. Returns 0 for a zero vector. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Element-wise mean of vectors (centroid). Assumes non-empty, equal-length. */
export function meanVector(vectors: Float32Array[]): Float32Array {
  const dim = vectors[0].length;
  const out = new Float32Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}
