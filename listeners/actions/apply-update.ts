import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import VectorStoreService from "../../services/vector-store";

const applyUpdateCallback = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const rawValue = body.actions[0].value;
    if (!rawValue) {
      throw new Error("No value provided");
    }

    const { fileName, sectionIndex, contentIndex, newContent } =
      JSON.parse(rawValue);

    const vectorStore = VectorStoreService.getInstance();
    const updatedMarkdown = await vectorStore.updateMarkdownContent(
      { fileName, sectionIndex, contentIndex },
      newContent
    );

    if (!updatedMarkdown) {
      throw new Error("Failed to update content");
    }

    await client.chat.postMessage({
      channel: body.channel?.id ?? "",
      thread_ts: body.container.thread_ts,
      text: "✅ Document has been updated successfully!",
    });
  } catch (error) {
    console.error(error);
    await client.chat.postMessage({
      channel: body.channel?.id ?? "",
      thread_ts: body.container.thread_ts,
      text: "❌ Failed to update document.",
    });
  }
};

export default applyUpdateCallback;
