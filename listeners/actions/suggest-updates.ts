import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import { createDiffBlock } from "../../services/slack-diff";
import { editMarkdownWithUserMessages } from "../../services/completions";
import { convertMarkdownToSlackText } from "../../services/markdown";
import {
  type EditData,
  extractKeysFromMessages,
  getStoredMessages,
  type SlackMessage,
  storeEditData,
} from "../../services/slack-utils";
import VectorStoreService from "../../services/vector-store";
import type { Button } from "@slack/types";

const suggestUpdatesCallback = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    // value 파싱
    const rawValue = body.actions[0].value;
    console.log("rawValue", rawValue);
    let currentIndex = 0;
    let validMessages: SlackMessage[] = [];

    if (rawValue) {
      const parsedValue = JSON.parse(rawValue);
      if ("index" in parsedValue) {
        // Next Suggestion 버튼에서 온 경우
        currentIndex = parsedValue.index;
        validMessages = getStoredMessages(parsedValue.messageKeys);
      }
    }

    // 첫 번째 제안인 경우에만 메시지 선택 상태 확인
    if (currentIndex === 0) {
      const blockId = Object.keys(body.state?.values ?? {})[0];
      const selectedOptions =
        body.state?.values?.[blockId]?.selected_messages?.selected_options;

      if (!selectedOptions || !Array.isArray(selectedOptions)) {
        throw new Error("No selected options provided");
      }

      validMessages = getStoredMessages(
        selectedOptions.map((option) => option.value)
      );
    }

    const vectorStore = VectorStoreService.getInstance();
    const searchResults = await vectorStore.similaritySearch(
      validMessages.map((msg) => msg.text).join("\n"),
      3
    );

    const mostRelevantDoc = searchResults[currentIndex];
    const { fileName, githubUrl } = mostRelevantDoc.metadata;
    const markdownSection =
      mostRelevantDoc.pageContent.split("---")[0].trim() ?? "";
    const markdownContent = mostRelevantDoc.pageContent.split("---")[1] ?? "";

    // // 선택된 메시지로 문서 편집
    const updatedContent = await editMarkdownWithUserMessages(
      markdownContent,
      validMessages
    );

    const oldSlackText = await convertMarkdownToSlackText(markdownContent);
    const newSlackText = await convertMarkdownToSlackText(updatedContent);
    const diffBlock = createDiffBlock(oldSlackText, newSlackText);

    const updatedMarkdown = await vectorStore.getUpdatedMarkdown({
      metadata: {
        fileName,
        sectionIndex: mostRelevantDoc.metadata.sectionIndex,
        contentIndex: mostRelevantDoc.metadata.contentIndex,
      },
      newContent: updatedContent,
    });

    if (!updatedMarkdown) {
      throw new Error("Failed to get updated markdown");
    }

    const editData: EditData = {
      fileName,
      updatedMarkdown,
      messages: validMessages,
      diffBlock,
      author: body.user.id,
    };

    const editDataKey = storeEditData(editData);

    // // 버튼에 다음 인덱스 정보 포함
    const nextIndex = currentIndex + 1;
    const hasNextSuggestion = nextIndex < searchResults.length;

    const uniqueAuthors = Array.from(
      new Set(validMessages.map((msg) => msg.userId))
    );

    const actionButtons: Button[] = [
      // {
      //   type: "button" as const,
      //   text: {
      //     type: "plain_text" as const,
      //     text: "Apply",
      //   },
      //   style: "primary" as const,
      //   action_id: "apply_update",
      //   value: JSON.stringify({
      //     editDataKey,
      //   }),
      // },
      {
        type: "button" as const,
        text: {
          type: "plain_text" as const,
          text: "Start Discussion",
        },
        style: "primary" as const,
        action_id: "start_discussion",
        value: JSON.stringify({
          stakeholders: uniqueAuthors,
          editDataKey,
        }),
      },
    ];

    if (hasNextSuggestion) {
      actionButtons.push({
        type: "button" as const,
        text: {
          type: "plain_text" as const,
          text: "Next Suggestion",
        },
        action_id: "suggest_updates",
        value: JSON.stringify({
          index: nextIndex,
          messageKeys: extractKeysFromMessages(validMessages),
        }),
      });
    }

    await client.chat.postEphemeral({
      channel: body.channel?.id ?? "",
      user: body.user.id,
      thread_ts: body.container.thread_ts,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "Document Updates Suggestion",
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*File:* <${githubUrl}|${fileName}>`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: markdownSection,
          },
        },
        {
          type: "divider",
        },
        diffBlock,
        {
          type: "actions",
          elements: actionButtons,
        },
      ],
    });
  } catch (error) {
    console.error(error);
  }
};

export default suggestUpdatesCallback;
