import OpenAI from "openai";
import dotenv from "dotenv";
import type { ChatCompletionMessageParam } from "openai/resources";
import type { SlackMessage } from "./slack-utils";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function createCompletion(
  model: string,
  messages: ChatCompletionMessageParam[]
) {
  try {
    return await openai.chat.completions.create({
      model,
      messages,
    });
  } catch (error) {
    console.error(error);
    throw error;
  }
}

export async function editMarkdownWithUserMessages(
  markdown: string,
  userMessages: SlackMessage[]
) {
  const completion = await createCompletion("gpt-4o", [
    {
      role: "system",
      content: `You edit markdown based on conversation content.

CRITICAL RULES:
- Only update with new information or correct factual errors from the conversation
- Preserve original sentence structure and formatting
- Change only necessary keywords, not entire sentences
- Do not fix grammar or style unless explicitly requested
- Return original markdown unchanged if no substantive updates needed

Return only the raw markdown with no code blocks, annotations, or explanations.`,
    },
    {
      role: "user",
      content: `<markdown>${markdown}</markdown>
<conversation>${userMessages
        .map(
          (message) =>
            `<${message.username}>${message.text}</${message.username}>`
        )
        .join("\n")}</conversation>`,
    },
  ]);

  return completion.choices[0].message.content ?? markdown;
}
