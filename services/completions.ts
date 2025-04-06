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
      content: `You are an AI assistant that helps edit markdown.
You will be given a markdown and conversation to modify it.
Return ONLY the edited markdown content without including the user's request or any explanations.
Do not wrap the response in markdown code blocks.
Do not add any formatting or annotations around the content.
Return the raw markdown content exactly as it should appear in the document.`,
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
