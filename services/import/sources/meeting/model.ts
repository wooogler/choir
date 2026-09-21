/**
 * Which model the estimate should be priced against.
 *
 * Split out from `estimate.ts` so that function can stay pure and synchronous:
 * it is fed a model name, not a workspace. The PDF path has the same split, but
 * gets it for free from `resolvePdfLlm` — which also builds an OpenAI client,
 * and the estimate has nothing to call.
 *
 * A workspace with no key cannot make a meeting note at all, so the refusal
 * happens here, at the estimate, rather than after the manager has approved a
 * price for a conversion that was always going to fail.
 */

import { ImportRefusal } from 'services/import/types';
import { resolveLLMConfig } from 'services/llm/llm-config';

export async function resolveMeetingModel(workspaceId: string): Promise<string> {
  try {
    return (await resolveLLMConfig(workspaceId, 'qa')).model;
  } catch {
    throw new ImportRefusal(422, 'import_llm_unavailable');
  }
}
