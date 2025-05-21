import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import { getStoredMessages } from "services/slack";
import suggestUpdatesCallback from "../../document-handlers/suggest-updates";

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
}

/**
 * 메시지 선택 액션 처리
 */
export async function handleSelectMessages({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) {
  await ack();

  try {
    const userId = body.user.id;
    const dmChannelId = body.channel?.id;
    const messageTs = body.message?.ts;

    if (!dmChannelId || !messageTs) {
      throw new Error("채널 ID 또는 메시지 타임스탬프를 찾을 수 없습니다");
    }

    // value 파싱
    const rawValue = body.actions[0].value;
    const parsedValue = JSON.parse(rawValue ?? "{}");
    const { originalChannelId, originalThreadTs } = parsedValue;

    // 체크박스 상태 가져오기
    const blockId = Object.keys(body.state?.values ?? {})[0];
    const selectedOptions = body.state?.values?.[blockId]?.check_messages?.selected_options;

    if (!selectedOptions || !Array.isArray(selectedOptions)) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: "메시지를 선택해주세요.",
      });
      return;
    }

    // 선택된 메시지 키 가져오기
    const messageKeys = selectedOptions.map((option) => option.value);
    const validMessages = getStoredMessages(messageKeys);

    if (validMessages.length === 0) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: "선택한 메시지를 찾을 수 없습니다.",
      });
      return;
    }

    // 선택된 메시지를 표시하는 블록 생성
    const selectedMessagesBlocks: SlackBlock[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "선택된 메시지",
          emoji: true
        }
      }
    ];
    
    // 선택된 각 메시지를 블록에 추가
    validMessages.forEach((message, idx) => {
      selectedMessagesBlocks.push(
        {
          type: "section", 
          text: {
            type: "mrkdwn",
            text: `*${message.username || "사용자"}*: ${message.text}`
          }
        }
      );
      
      // 마지막 메시지가 아니면 구분선 추가
      if (idx < validMessages.length - 1) {
        selectedMessagesBlocks.push({
          type: "divider"
        } as SlackBlock);
      }
    });
    
    // 구분선 추가
    selectedMessagesBlocks.push({
      type: "divider"
    } as SlackBlock);

    // 메시지 업데이트 (문서 업데이트 제안 버튼 없이)
    await client.chat.update({
      channel: dmChannelId,
      ts: messageTs,
      text: "선택된 메시지",
      blocks: selectedMessagesBlocks
    });

    // 바로 문서 업데이트 제안 프로세스 시작
    await suggestUpdatesCallback({
      ack: async () => {},
      body: {
        user: { id: userId },
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
    console.error("메시지 선택 처리 중 오류 발생:", error);
    
    // 에러 메시지 전송
    const channelId = body.channel?.id;
    if (channelId) {
      await client.chat.postMessage({
        channel: channelId,
        text: `메시지 선택 처리 중 오류가 발생했습니다: ${
          error instanceof Error ? error.message : "알 수 없는 오류"
        }`
      });
    }
  }
}