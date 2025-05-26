import type {
  AllMiddlewareArgs,
  SlackViewMiddlewareArgs,
  SlackViewAction,
} from "@slack/bolt";
import suggestUpdatesCallback from "../document-handlers/suggest-updates";
import { getStoredMessages, formatSlackMessageBlock } from "services/slack";

/**
 * 메시지 선택 모달 제출 처리
 */
export async function handleMessageSelectionModal({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<SlackViewAction>) {
  await ack();

  try {
    const { originalChannelId, originalThreadTs, dmChannelId } = JSON.parse(
      body.view.private_metadata
    );

    // 선택된 메시지들 가져오기 (개별 섹션 구조에서)
    const stateValues = body.view.state.values;
    const selectedMessageKeys: string[] = [];

    // 각 메시지 체크박스에서 선택된 값들 수집
    Object.keys(stateValues).forEach(blockId => {
      Object.keys(stateValues[blockId]).forEach(actionId => {
        if (actionId.startsWith('select_message_')) {
          const selectedOptions = stateValues[blockId][actionId].selected_options;
          if (selectedOptions && selectedOptions.length > 0) {
            selectedOptions.forEach((option: any) => {
              selectedMessageKeys.push(option.value);
            });
          }
        }
      });
    });

    if (selectedMessageKeys.length === 0) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: "Please select at least one message to proceed.",
      });
      return;
    }

    // 선택된 메시지 키들
    const messageKeys = selectedMessageKeys;

    // 선택된 메시지들 가져오기
    const validMessages = getStoredMessages(messageKeys);

    // 선택된 메시지들을 표시할 블록 생성
    const selectedMessagesBlocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Document Update",
          emoji: true
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✅ Selected ${messageKeys.length} message(s) for document update:`
        }
      }
    ];

    // 각 선택된 메시지를 블록으로 추가
    for (const message of validMessages) {
      const formattedBlock = await formatSlackMessageBlock(message, false); // 전체 메시지 표시
      selectedMessagesBlocks.push({
        type: "section",
        text: formattedBlock.text
      });
    }

    // 구분선 추가
    selectedMessagesBlocks.push({
      type: "divider"
    } as any);

    // DM 채널에 선택된 메시지들 표시
    await client.chat.postMessage({
      channel: dmChannelId,
      text: "Processing selected messages...",
      blocks: selectedMessagesBlocks
    });

    // 문서 업데이트 제안 프로세스 시작
    await suggestUpdatesCallback({
      ack: async () => {},
      body: {
        user: { id: body.user.id },
        channel: { id: dmChannelId },
        actions: [
          {
            value: JSON.stringify({
              messageKeys,
              originalChannelId,
              originalThreadTs,
              action: "generate_updates"
            })
          }
        ],
        container: { thread_ts: originalThreadTs }
      },
      client
    } as any);

  } catch (error) {
    console.error("Error processing message selection:", error);
    
    const dmChannelId = JSON.parse(body.view.private_metadata).dmChannelId;
    if (dmChannelId) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: `Error processing message selection: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      });
    }
  }
} 