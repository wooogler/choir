import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { VectorStoreService } from "../../services/index";
import { generateCompletion } from "../../services/completions";
import { getManagers, getWorkspaceId } from "../../services/slack-utils";

const dmCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"message">) => {
  // Skip if not DM or message is edited
  if (event.channel_type !== "im" || event.subtype === "message_changed")
    return;

  try {
    // Get user message
    const userMessage = "text" in event ? event.text : "";
    if (!userMessage) return;

    // Get user ID from event
    const userId = "user" in event && event.user ? event.user : "";

    // Get message history
    const historyResult = await client.conversations.history({
      channel: event.channel,
      limit: 10,
    });

    // Get relevant documents from vector store
    const vectorStore = VectorStoreService.getInstance();
    const relevantDocs = await vectorStore.similaritySearch(userMessage, 3);

    // Generate and send response
    const response = await generateCompletion(
      userMessage,
      historyResult.messages || [],
      relevantDocs
    );

    if (response) {
      // Send the main response
      const result = await client.chat.postMessage({
        channel: event.channel,
        text: response,
        mrkdwn: true,
      });

      // Create a thread with relevant document information
      if (result.ts && relevantDocs.length > 0) {
        // Format document information for the thread
        const documentInfo = relevantDocs
          .map((doc, index) => {
            const metadata = doc.metadata;
            const sectionInfo = metadata.sectionName
              ? `*Section:* ${metadata.sectionName}\n`
              : "";
            const gitbookLink = metadata.gitbookSectionLink
              ? `*GitBook Link:* <${metadata.gitbookSectionLink}|${
                  metadata.sectionName || "View Document"
                }>\n`
              : "";
            const githubLink = metadata.githubUrl
              ? `*GitHub Link:* <${metadata.githubUrl}|View Source Code>\n`
              : "";

            // Display document content longer (up to 500 characters)
            const contentPreview =
              doc.pageContent.length > 500
                ? `${doc.pageContent.substring(0, 500)}...`
                : doc.pageContent;

            return `*Reference Document ${
              index + 1
            }*\n${sectionInfo}${gitbookLink}${githubLink}*Related Content:*\n\`\`\`${contentPreview}\`\`\`\n`;
          })
          .join("\n");

        // Send document information in a thread
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: result.ts,
          text: `*Reference Document Information:*\n\n${documentInfo}\n\nFor more detailed information, please check the links above.`,
          mrkdwn: true,
        });

        try {
          await client.chat.postMessage({
            channel: event.channel,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "Would you like to ask a question about this document?",
                },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: {
                      type: "plain_text",
                      text: "Ask Direct Question",
                      emoji: true,
                    },
                    style: "primary",
                    action_id: "start_consultation",
                    value: JSON.stringify({
                      stakeholders: [userId],
                      validMessages: [
                        {
                          userId: userId,
                          username: "User",
                          text: userMessage,
                          ts: event.ts,
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          });
        } catch (error) {
          logger.error("Error adding discussion button:", error);
          // Continue even if button addition fails
        }
      }
    }
  } catch (error) {
    logger.error("Error processing DM response:", error);
    await client.chat.postMessage({
      channel: event.channel,
      text: "I'm sorry. An error occurred. Please try again.",
    });
  }
};

export default dmCallback;
