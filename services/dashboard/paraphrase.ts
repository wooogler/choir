import { createChatCompletion } from 'services/llm/completions';

const PARAPHRASE_SYSTEM_PROMPT = `Rewrite the user's question as a short, generic FAQ-style question in English.
Remove all personal context: names, projects, deadlines, individual circumstances, and any specifics that identify who is asking.
Keep only the underlying information need. Output only the rewritten question — no quotes, no preamble.

Example: "I'm the second author on a CHI paper, can I still get travel funding?"
      -> "Is conference travel funding available for second authors?"`;

/**
 * Rewrites a question into a de-contextualized FAQ form for the dashboard. The
 * caller MUST pass text that has already been anonymized (real names replaced with
 * pseudonyms). `skipAnonymization` bypasses the LLM helper's de-anonymization pass
 * so names are never restored into the stored paraphrase — critically, omitting
 * workspaceId would NOT do this (the anonymization map is global when unscoped, so
 * de-anonymization would still run). workspaceId is passed only to resolve the
 * workspace's API key/model.
 *
 * Uses the cheap classification model. Returns null on any failure (missing API
 * key, LLM error) so the caller can skip recording rather than store raw text.
 */
export async function paraphraseQuestion(anonymizedQuestion: string, workspaceId?: string): Promise<string | null> {
  const trimmed = anonymizedQuestion.trim();
  if (!trimmed) return null;

  try {
    const result = await createChatCompletion(
      [
        { role: 'system', content: PARAPHRASE_SYSTEM_PROMPT },
        { role: 'user', content: trimmed },
      ],
      {
        workspaceId, // key/model resolution only
        skipAnonymization: true, // input is already anonymized; never restore names in the output
        purpose: 'classification',
        temperature: 0,
        max_tokens: 80,
        function_name: 'dashboardParaphrase',
      },
    );
    const cleaned = result.trim();
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    // Missing key / API error → skip this event. Never fall back to raw text.
    return null;
  }
}
