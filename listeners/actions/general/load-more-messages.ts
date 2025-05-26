import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import { getStoredMessage } from "services/slack";

/**
 * Load More 메시지 액션 처리
 */
export async function handleLoadMoreMessages({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) {
  await ack();

  try {
    const rawValue = body.actions[0].value;
    const parsedValue = JSON.parse(rawValue ?? "{}");
    const { originalChannelId, originalThreadTs, messageKeys, channelName, currentLimit, allMessageKeys } = parsedValue;

    // 현재 선택된 메시지들 파악
    const currentStateValues = body.view?.state?.values || {};
    const currentlySelectedKeys: string[] = [];
    
    Object.keys(currentStateValues).forEach(blockId => {
      Object.keys(currentStateValues[blockId]).forEach(actionId => {
        if (actionId.startsWith('select_message_')) {
          const selectedOptions = currentStateValues[blockId][actionId].selected_options;
          if (selectedOptions && selectedOptions.length > 0) {
            selectedOptions.forEach((option: any) => {
              currentlySelectedKeys.push(option.value);
            });
          }
        }
      });
    });

    // 저장된 메시지들을 가져와서 전체 내용 표시
    const messages = messageKeys.map((key: string) => getStoredMessage(key)).filter(Boolean);
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
      
      // 현재 선택된 메시지들 유지 (기존에 선택된 메시지는 계속 선택됨)
      const isInitiallySelected = currentlySelectedKeys.includes(messageKeys[index]);
      
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





    // 모달 업데이트
    if (!body.view?.id) {
      throw new Error("View ID not found");
    }
    
    await client.views.update({
      view_id: body.view.id,
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
          dmChannelId: body.view?.private_metadata ? JSON.parse(body.view.private_metadata).dmChannelId : null
        }),
        blocks: modalBlocks
      }
    });

  } catch (error) {
    console.error("Error loading more messages:", error);
    
    // 에러 발생 시 사용자에게 알림
    if (body.view?.private_metadata) {
      const { dmChannelId } = JSON.parse(body.view.private_metadata);
      if (dmChannelId) {
        await client.chat.postMessage({
          channel: dmChannelId,
          text: `Error loading more messages: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        });
      }
    }
  }
} 