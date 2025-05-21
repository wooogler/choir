import { createSlackMessageWithName, formatSlackMessageBlock, SlackMessage } from "services/slack";
import { WebClient } from "@slack/web-api";

interface MessageResult {
  ts: string;
  channel: string;
  ok: boolean;
}

/**
 * 업데이트 요청 메시지 처리
 */
export async function handleUpdateRequestMessage(client: WebClient, event: any, logger: any) {
  try {
    const userId = event.user;
    const originalChannelId = event.channel;
    const originalThreadTs = event.ts;
    
    // 원래 채널에 간단한 반응만 추가 (DM 확인 메시지 제거)
    try {
      await client.reactions.add({
        channel: originalChannelId,
        name: "eyes",
        timestamp: originalThreadTs
      });
    } catch (reactionError) {
      logger.warn("Failed to add reaction:", reactionError);
    }
    
    // DM 채널 열기
    const dmResult = await client.conversations.open({
      users: userId
    });
    
    if (!dmResult.ok || !dmResult.channel?.id) {
      throw new Error("DM 채널을 열 수 없습니다");
    }
    
    const dmChannelId = dmResult.channel.id;
    
    // DM에 진행 중 메시지 표시
    const progressMessage = await client.chat.postMessage({
      channel: dmChannelId,
      text: "메시지 이력을 불러오는 중입니다...",
    }) as MessageResult;

    const historyResult = await client.conversations.history({
      channel: originalChannelId,
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

      // 체크박스 옵션 Slack API 형식으로 변환
      const checkboxOptions = messageOptions.map((option) => ({
        text: option.text,
        value: option.value,
      }));

      const messageBlocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*저장할 메시지 선택*",
          },
        },
        {
          type: "actions",
          block_id: "message_selection",
          elements: [
            {
              type: "checkboxes",
              action_id: "check_messages",
              options: checkboxOptions,
              initial_options: checkboxOptions,
            },
          ],
        },
      ];
      
      // 진행 중 메시지 삭제
      try {
        await client.chat.delete({
          channel: dmChannelId,
          ts: progressMessage.ts
        });
      } catch (deleteError) {
        logger.error("진행 중 메시지 삭제 실패:", deleteError);
      }

      // DM으로 선택 UI 메시지 전송
      await client.chat.postMessage({
        channel: dmChannelId,
        text: "저장할 메시지를 선택해주세요.",
        blocks: [
          ...messageBlocks,
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "문서 업데이트 제안",
                },
                action_id: "select_messages",
                value: JSON.stringify({
                  originalChannelId,
                  originalThreadTs,
                  messageTs: progressMessage.ts
                })
              },
            ],
          },
        ],
      }) as MessageResult;

      return true;
    }
    return false;
  } catch (error) {
    logger.error("Error handling update request message:", error);
    throw error;
  }
} 