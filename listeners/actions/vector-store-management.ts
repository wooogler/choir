import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";

/**
 * Vector store cache rebuild action handler
 */
export const rebuildVectorCacheAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    // Extract user ID
    const userId = body.user.id;

    // Display message indicating the operation may take time
    await client.chat.postMessage({
      channel: userId,
      text: "Rebuilding vector store cache. Please wait...",
    });

    // Load service and rebuild cache
    const VectorStoreService = (await import("../../services/index"))
      .VectorStoreService;
    const vectorStore = VectorStoreService.getInstance();
    const result = await vectorStore.forceRebuildCache();

    // Report results
    if (result) {
      await client.chat.postMessage({
        channel: userId,
        text: "✅ Vector store cache has been successfully rebuilt!",
      });
    } else {
      await client.chat.postMessage({
        channel: userId,
        text: "❌ An issue occurred during vector store cache rebuild. Please check the logs.",
      });
    }
  } catch (error) {
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Error occurred: ${error}`,
    });
  }
};

/**
 * Vector store emergency reset action handler
 */
export const resetVectorStoreAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    // Extract user ID
    const userId = body.user.id;

    // Display message indicating the operation may take time
    await client.chat.postMessage({
      channel: userId,
      text: "⚠️ Completely resetting and rebuilding the vector store. This operation may take several minutes...",
    });

    // Load service and execute full reset
    const VectorStoreService = (await import("../../services/index"))
      .VectorStoreService;
    const vectorStore = VectorStoreService.getInstance();
    const result = await vectorStore.resetAndRebuildVectorStore();

    // Report results
    if (result) {
      await client.chat.postMessage({
        channel: userId,
        text: "✅ Vector store has been successfully reset and rebuilt!",
      });
    } else {
      await client.chat.postMessage({
        channel: userId,
        text: "❌ Failed to reset and rebuild vector store. Please check the logs.",
      });
    }
  } catch (error) {
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Error occurred during emergency reset: ${error}`,
    });
  }
};
