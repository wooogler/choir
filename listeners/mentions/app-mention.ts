import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import {
  createSlackMessageWithName,
  formatSlackMessageBlock,
  type SlackMessage,
  getStoredMessages,
} from "../../services/slack-utils";
import { VectorStoreService } from "../../services/index";
import { classifyMessageIntent, generateCompletion } from "../../services/completions";

const appMentionCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">) => {
  try {
    // Get user message from the mention event
    const userMessage = "text" in event ? event.text.replace(/<@[A-Z0-9]+>/, "").trim() : "";
    if (!userMessage) return;

    // Classify message intent (question or update request)
    const messageIntent = await classifyMessageIntent(userMessage);
    logger.info(`Message intent classified as: ${messageIntent}`);

    if (messageIntent === "question") {
      // Handle as a question - similar to dm-answer.ts
      await handleQuestionMessage(client, event, userMessage, logger);
    } else {
      // Handle as update request - use existing functionality
      await handleUpdateRequestMessage(client, event, logger);
    }
  } catch (error) {
    logger.error("Error processing app mention:", error);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: "I'm sorry. An error occurred. Please try again.",
    });
  }
};

// Handle a question intent message
async function handleQuestionMessage(client: any, event: any, userMessage: string, logger: any) {
  try {
    // Get message history for context (limit to 5 previous messages)
    const historyResult = await client.conversations.history({
      channel: event.channel,
      limit: 5,
    });

    // Get relevant documents from vector store
    const vectorStore = VectorStoreService.getInstance();
    const relevantDocs = await vectorStore.similaritySearch(userMessage, 3);

    // Generate response
    const response = await generateCompletion(
      userMessage,
      historyResult.messages || [],
      relevantDocs
    );

    // Send the response to the main channel (not in thread)
    const result = await client.chat.postMessage({
      channel: event.channel,
      text: response,
      mrkdwn: true,
    });

    // Add document references in thread if available
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

          // Display document content preview
          const contentPreview =
            doc.pageContent.length > 500
              ? `${doc.pageContent.substring(0, 500)}...`
              : doc.pageContent;

          return `*Reference Document ${
            index + 1
          }*\n${sectionInfo}${gitbookLink}${githubLink}*Related Content:*\n\`\`\`${contentPreview}\`\`\`\n`;
        })
        .join("\n");

      // Send document information in the thread of the response
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: result.ts,
        text: `*Reference Document Information:*\n\n${documentInfo}\n\nFor more detailed information, please check the links above.`,
        mrkdwn: true,
      });

      // Add "Ask Direct Question" button in the same thread
      try {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: result.ts,
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
                    stakeholders: [event.user],
                    validMessages: [
                      {
                        userId: event.user,
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
  } catch (error) {
    logger.error("Error handling question message:", error);
    throw error;
  }
}

// Handle an update request intent message - use existing functionality
async function handleUpdateRequestMessage(client: any, event: any, logger: any) {
  try {
    const historyResult = await client.conversations.history({
      channel: event.channel,
      limit: 5,
    });

    if (historyResult.messages?.length) {
      const messages = (historyResult.messages ?? []).reverse();
      const slackMessages = (
        await Promise.all(
          messages.map((msg: any) => createSlackMessageWithName(msg, client))
        )
      ).filter((msg): msg is SlackMessage => msg !== null);

      const messageOptions = await Promise.all(
        slackMessages.map(formatSlackMessageBlock)
      );

      // Convert checkbox options to Slack API format
      const checkboxOptions = messageOptions.map((option) => ({
        text: option.text,
        value: option.value,
      }));

      const messageBlocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Select Messages to Save*",
          },
        },
        {
          type: "actions",
          block_id: "message_selection",
          elements: [
            {
              type: "checkboxes",
              action_id: "selected_messages",
              options: checkboxOptions,
              initial_options: checkboxOptions,
            },
          ],
        },
      ];

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `<@${event.user}> requested CHOIR to edit the document.`,
      });

      await client.chat.postEphemeral({
        channel: event.channel,
        user: event.user ?? "unknown",
        thread_ts: event.ts,
        text: "Please select the messages you want to save.",
        blocks: [
          ...messageBlocks,
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Suggest Document Updates",
                },
                action_id: "suggest_updates",
              },
            ],
          },
        ],
      });
    }
  } catch (error) {
    logger.error("Error handling update request message:", error);
    throw error;
  }
}

export default appMentionCallback;
