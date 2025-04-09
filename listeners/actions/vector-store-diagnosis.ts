import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";

/**
 * Vector store diagnosis action handler
 */
export const diagnoseVectorStoreAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    // Extract user ID
    const userId = body.user.id;

    // Diagnosis start message
    await client.chat.postMessage({
      channel: userId,
      text: "Performing vector store diagnosis...",
    });

    // Load vector store service
    const VectorStoreService = (await import("../../services/index"))
      .VectorStoreService;
    const vectorStore = VectorStoreService.getInstance();

    // Run diagnosis
    const diagnosis = vectorStore.diagnoseVectorStore();

    // Get cache file information
    const fs = (await import("fs")).default;
    const path = (await import("path")).default;

    // Find cache files
    const cacheManager = vectorStore.getCacheManager
      ? vectorStore.getCacheManager()
      : null;
    const cacheFiles = cacheManager ? await cacheManager.findCacheFiles() : [];

    const filesInfo = cacheFiles
      .map((file: string) => {
        try {
          const stats = fs.statSync(file);
          const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
          const lastModified = stats.mtime.toISOString();
          return `- ${path.basename(
            file
          )}: ${fileSizeInMB}MB (Last modified: ${lastModified})`;
        } catch (e) {
          return `- ${path.basename(file)}: Failed to read file information`;
        }
      })
      .join("\n");

    // Display diagnosis results
    await client.chat.postMessage({
      channel: userId,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "Vector Store Diagnosis Results",
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Status:* ${diagnosis.status}\n*Healthy:* ${
              diagnosis.status === "healthy" ? "✅ Yes" : "❌ No"
            }`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Documents:* ${diagnosis.details.documentCount}\n*Vectors:* ${diagnosis.details.vectorsCount}\n*Cache Files:* ${cacheFiles.length}`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Cache File Information:*\n${filesInfo || "No cache files"}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Rebuild Cache",
                emoji: true,
              },
              style: "primary",
              action_id: "rebuild_vector_cache",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Emergency Reset",
                emoji: true,
              },
              style: "danger",
              action_id: "reset_vector_store",
              confirm: {
                title: {
                  type: "plain_text",
                  text: "Are you sure you want to reset?",
                },
                text: {
                  type: "plain_text",
                  text: "This will completely reset the vector store and rebuild it. This action cannot be undone.",
                },
                confirm: {
                  type: "plain_text",
                  text: "Execute Reset",
                },
                deny: {
                  type: "plain_text",
                  text: "Cancel",
                },
              },
            },
          ],
        },
      ],
      text: "Vector store diagnosis results.",
    });
  } catch (error) {
    // Notify user via DM if an error occurs
    await client.chat.postMessage({
      channel: body.user.id,
      text: `An error occurred during vector store diagnosis: ${error}`,
    });
  }
};
