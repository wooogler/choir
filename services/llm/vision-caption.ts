import { resolveLLMConfig } from './llm-config';
import { getOpenAIClient } from './openai-client-factory';

const MAX_CAPTION_TOKENS = 500;
const MAX_SHORT_CAPTION_CHARS = 200;

const CAPTION_PROMPT = `You are describing an image embedded in technical documentation. Your output is used for (a) a short visible figure caption and (b) text-search retrieval.
Respond in plain text with exactly this structure:
- Line 1: a single concise caption, at most 140 characters, on one line with no line breaks — suitable as a figure caption.
- A blank line.
- A fuller description, and if the image contains legible text, transcribe it verbatim after a line starting with "Text:".
Be specific and factual; do not speculate beyond what is visible.`;

export interface ImageCaptionResult {
  /** One concise line for the visible figure caption / image alt text. */
  shortCaption: string;
  /** Full description + transcribed text, for the search index. */
  indexText: string;
  model: string;
}

/** Collapses to a single sanitized line usable as markdown image alt text. */
function toShortCaption(firstLine: string): string {
  const oneLine = firstLine.replace(/\s+/g, ' ').replace(/]/g, ')').trim();
  return oneLine.length > MAX_SHORT_CAPTION_CHARS
    ? `${oneLine.slice(0, MAX_SHORT_CAPTION_CHARS - 1).trim()}…`
    : oneLine;
}

/**
 * Generates a caption for an image using the workspace's configured
 * vision-capable model via the OpenAI Responses API. Returns a short caption
 * (for the visible figure caption / alt text) plus the full text (description +
 * transcription) used for search indexing. The image is passed inline as a
 * base64 data URL. Throws on failure so callers can decide how to degrade.
 */
export async function generateImageCaption(params: {
  workspaceId: string;
  dataUrl: string;
  alt?: string;
}): Promise<ImageCaptionResult> {
  const resolved = await resolveLLMConfig(params.workspaceId, 'qa');
  const client = getOpenAIClient(resolved.apiKey);

  const altHint = params.alt?.trim() ? `\n\nThe author's alt text for this image is: "${params.alt.trim()}".` : '';

  const response = await client.responses.create({
    model: resolved.model,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: CAPTION_PROMPT + altHint },
          { type: 'input_image', image_url: params.dataUrl, detail: 'auto' },
        ],
      },
    ],
    max_output_tokens: MAX_CAPTION_TOKENS,
  });

  const indexText = (response.output_text || '').trim();
  if (!indexText) {
    throw new Error('Vision model returned an empty caption');
  }

  const firstLine = indexText.split('\n').find((line) => line.trim().length > 0) ?? indexText;
  return { shortCaption: toShortCaption(firstLine), indexText, model: resolved.model };
}

/** Derives a short caption from already-indexed caption text (first line). */
export function deriveShortCaption(indexText: string): string {
  const firstLine = indexText.split('\n').find((line) => line.trim().length > 0) ?? indexText;
  return toShortCaption(firstLine);
}
