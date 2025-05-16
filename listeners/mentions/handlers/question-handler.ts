import type { SlackMessage } from "../../../services/slack-utils";
import {
  createSlackMessageWithName,
  formatSlackMessageBlock,
  getWorkspaceId,
  getManagers,
  createGitbookSectionLink,
} from "../../../services/slack-utils";
import { VectorStoreService } from "../../../services/index";
import { generateCompletion } from "../../../services/completions";
import { generateSessionId, storeSessionData, SessionType } from "../../../services/session-store";

export async function handleQuestionMessage(client: any, event: any, userMessage: string, logger: any) {
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

    // Extract all unique user IDs from the conversation history
    const historyUsers = new Set<string>();
    historyUsers.add(event.user); // Add the current user who triggered the mention
    
    // Add all other users from conversation history
    (historyResult.messages || []).forEach((msg: any) => {
      if (msg.user && typeof msg.user === 'string') {
        historyUsers.add(msg.user);
      }
    });

    // Convert history messages to validMessages format
    const validMessages = (historyResult.messages || []).map((msg: any) => ({
      userId: msg.user || msg.bot_id || "unknown",
      username: msg.username || (msg.bot_id ? "CHOIR" : "User"), // Use "CHOIR" for bot messages
      text: msg.text,
      ts: msg.ts
    }));
    
    // Make sure the current mention is included (it might be too recent for history)
    const currentMessageIncluded = validMessages.some((msg: any) => msg.ts === event.ts);
    if (!currentMessageIncluded) {
      validMessages.push({
        userId: event.user,
        username: "User",
        text: userMessage,
        ts: event.ts,
      });
    }

    // Add the bot's current response to validMessages as well
    validMessages.push({
      userId: "bot", // Use a placeholder for bot ID
      username: "CHOIR",
      text: response,
      ts: (Math.floor(Date.now() / 1000) + "." + Date.now() % 1000), // Slack timestamp format: seconds.milliseconds
    });

    // Sort all messages by timestamp (descending) so latest messages appear at the top
    validMessages.sort((a: SlackMessage, b: SlackMessage) => {
      const tsA = parseFloat(a.ts);
      const tsB = parseFloat(b.ts);
      return tsB - tsA; // Descending order (newest first)
    });

    // Get workspace ID and managers list
    const workspaceId = await getWorkspaceId(client);
    const managers = getManagers(workspaceId);
    
    // Format managers for display
    let managersText = "";
    if (managers && managers.length > 0) {
      managersText = managers.map((uid: string) => `<@${uid}>`).join(", ");
    } else {
      managersText = "No managers available";
    }

    // Generate session ID
    const sessionId = generateSessionId("consultation");

    // Store session data
    storeSessionData(
      sessionId,
      {
        stakeholders: Array.from(historyUsers),
        validMessages: validMessages,
      },
      SessionType.CONSULTATION
    );

    // Send the response to the main channel with the button
    const mainBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: response
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Would you like to discuss this question with managers: ${managersText}`
        }
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
            value: sessionId,
          },
        ],
      }
    ];

    const result = await client.chat.postMessage({
      channel: event.channel,
      text: response,
      mrkdwn: true,
      blocks: mainBlocks
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
          const gitbookLink = metadata.sectionName
            ? `*GitBook Link:* <${createGitbookSectionLink(metadata.sectionName, metadata.fileName)}|${
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
    }
  } catch (error) {
    logger.error("Error handling question message:", error);
    throw error;
  }
} 