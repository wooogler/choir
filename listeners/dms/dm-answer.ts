import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import OpenAI from "openai";
import dotenv from "dotenv";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import VectorStoreService from "../../services/vector-store";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const dmCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"message">) => {
  if (event.channel_type !== "im" || event.subtype === "message_changed")
    return;

  try {
    const historyResult = await client.conversations.history({
      channel: event.channel,
      limit: 10,
    });

    const userMessage = historyResult.messages?.[0]?.text;
    if (!userMessage) return;

    const vectorStore = VectorStoreService.getInstance();
    const relevantDocs = await vectorStore.similaritySearch(userMessage, 3);

    const context = relevantDocs
      .map(
        (doc) => `Content from ${doc.metadata.fileName}:\n${doc.pageContent}`
      )
      .join("\n\n");

    const messages = historyResult.messages?.reverse().map((msg) => ({
      role: msg.bot_id ? "assistant" : "user",
      content: msg.text,
    }));

    // TODO: load more
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an AI assistant that provides answers based on the lab's documentation. 
Please refer to the following document content to answer user questions:

${context}

When answering, please cite and explain the relevant parts of the documentation you're referencing.`,
        },
        ...(messages as ChatCompletionMessageParam[]),
      ],
    });

    if (completion.choices[0].message.content) {
      await client.chat.postMessage({
        channel: event.channel,
        text: completion.choices[0].message.content,
        mrkdwn: true,
      });
    }
  } catch (error) {
    logger.error(error);
    await client.chat.postMessage({
      channel: event.channel,
      text: "Sorry, an error occurred. Please try again.",
    });
  }
};

export default dmCallback;
