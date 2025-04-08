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
              ? `*섹션:* ${metadata.sectionName}\n`
              : "";
            const gitbookLink = metadata.gitbookSectionLink
              ? `*GitBook 링크:* <${metadata.gitbookSectionLink}|${
                  metadata.sectionName || "문서 보기"
                }>\n`
              : "";
            const githubLink = metadata.githubUrl
              ? `*GitHub 링크:* <${metadata.githubUrl}|소스 코드 보기>\n`
              : "";

            // 문서 내용을 더 길게 표시 (500자까지)
            const contentPreview =
              doc.pageContent.length > 500
                ? `${doc.pageContent.substring(0, 500)}...`
                : doc.pageContent;

            return `*참조 문서 ${
              index + 1
            }*\n${sectionInfo}${gitbookLink}${githubLink}*관련 내용:*\n\`\`\`${contentPreview}\`\`\`\n`;
          })
          .join("\n");

        // Send document information in a thread
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: result.ts,
          text: `*참조한 문서 정보:*\n\n${documentInfo}\n\n더 자세한 정보는 위 링크를 통해 확인하실 수 있습니다.`,
          mrkdwn: true,
        });

        // 관리자만 볼 수 있는 "토론 시작" 버튼 추가
        try {
          // 워크스페이스 ID 가져오기
          const workspaceId = await getWorkspaceId(client);

          // 관리자 목록 가져오기
          const managers = getManagers(workspaceId);

          // 현재 사용자가 관리자인지 확인
          const isManager = managers.includes(userId);

          if (isManager) {
            // 토론 시작 버튼 추가
            await client.chat.postMessage({
              channel: event.channel,
              thread_ts: result.ts,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: "이 문서에 대해 직접 질문하시겠습니까?",
                  },
                },
                {
                  type: "actions",
                  elements: [
                    {
                      type: "button",
                      text: {
                        type: "plain_text",
                        text: "직접 질문하기",
                        emoji: true,
                      },
                      style: "primary",
                      action_id: "start_consultation",
                      value: JSON.stringify({
                        stakeholders: [userId],
                        validMessages: [
                          {
                            username: "AI Assistant",
                            text: response,
                            ts: result.ts,
                          },
                        ],
                      }),
                    },
                  ],
                },
              ],
            });
          }
        } catch (error) {
          logger.error("Error adding discussion button:", error);
          // 버튼 추가 실패 시에도 계속 진행
        }
      }
    }
  } catch (error) {
    logger.error("Error processing DM response:", error);
    await client.chat.postMessage({
      channel: event.channel,
      text: "죄송합니다. 오류가 발생했습니다. 다시 시도해주세요.",
    });
  }
};

export default dmCallback;
