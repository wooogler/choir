import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import { getStoredMessage } from "services/slack";

/**
 * 메시지 선택 모달 열기 액션 처리
 */
export async function handleOpenMessageSelectionModal({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) {
  await ack();

  try {
    const rawValue = body.actions[0].value;
    const parsedValue = JSON.parse(rawValue ?? "{}");
    const { originalChannelId, originalThreadTs, messageKeys, channelName, currentLimit = 5, allMessageKeys = messageKeys } = parsedValue;

    // 저장된 메시지들을 가져와서 전체 내용 표시 (현재 표시할 메시지들)
    const messages = messageKeys.map((key: string) => getStoredMessage(key)).filter(Boolean);
    
    // 전체 메시지 목록 (Load More를 위해)
    const allMessages = allMessageKeys.map((key: string) => getStoredMessage(key)).filter(Boolean);

    // 모달에 표시할 블록들 생성
    const modalBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Select messages from ${channelName} to use for document update:*`
        }
      },
      {
        type: "divider"
      }
    ];

    // Load More 버튼을 위쪽에 배치 (더 많은 메시지가 있는 경우)
    if (allMessages.length > messages.length) {
      const nextLimit = currentLimit + 5;
      const nextMessageKeys = allMessageKeys.slice(-nextLimit);
      
      modalBlocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: `Load More (${Math.min(5, allMessages.length - messages.length)} more messages)`
            },
            action_id: "load_more_messages",
            value: JSON.stringify({
              originalChannelId,
              originalThreadTs,
              messageKeys: nextMessageKeys,
              channelName,
              currentLimit: nextLimit,
              allMessageKeys
            })
          }
        ]
      } as any);
      
      // Load More 버튼 아래에 구분선 추가
      modalBlocks.push({
        type: "divider"
      } as any);
    }

    // 각 메시지를 개별 섹션으로 표시 (체크박스 포함)
    messages.forEach((message: any, index: number) => {
      const timestamp = new Date(Number(message.ts) * 1000).toLocaleString();
      
      // 첫 번째 메시지가 아닌 경우 구분선 추가
      if (index > 0) {
        modalBlocks.push({
          type: "divider"
        } as any);
      }
      
      // 마지막 메시지만 초기 선택된 상태로 설정
      const isInitiallySelected = index === messages.length - 1;
      
      modalBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${message.username}* • ${timestamp}\n${message.text}`
        },
        accessory: {
          type: "checkboxes",
          action_id: `select_message_${index}`,
          options: [
            {
              text: {
                type: "plain_text",
                text: "Select"
              },
              value: messageKeys[index]
            }
          ],
          ...(isInitiallySelected && {
            initial_options: [
              {
                text: {
                  type: "plain_text",
                  text: "Select"
                },
                value: messageKeys[index]
              }
            ]
          })
        }
      } as any);
    });





    // 모달 열기
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "message_selection_modal",
        title: {
          type: "plain_text",
          text: "Select Messages"
        },
        submit: {
          type: "plain_text",
          text: "Continue"
        },
        close: {
          type: "plain_text",
          text: "Cancel"
        },
        private_metadata: JSON.stringify({
          originalChannelId,
          originalThreadTs,
          dmChannelId: body.channel?.id
        }),
        blocks: modalBlocks
      }
    });

  } catch (error) {
    console.error("Error opening message selection modal:", error);
    
    const channelId = body.channel?.id;
    if (channelId) {
      await client.chat.postMessage({
        channel: channelId,
        text: `Error opening message selection: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      });
    }
  }
} 