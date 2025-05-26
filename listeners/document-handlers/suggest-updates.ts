import { Document } from "@langchain/core/documents";
import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import type { KnownBlock, Block } from "@slack/web-api";
import { processDocument } from "services/document/update-processor";
import { 
  storeDocumentUpdates, 
  getSearchResults, 
  removeDocumentUpdate,
  getStoredDocumentUpdates,
  DocumentUpdate,
  storeSearchResults
} from "services/document/document-store";
import { getStoredMessages } from "services/slack";
import { SlackMessage } from "services/slack";
import { checkVectorStoreHealth } from "services/vector/health-check";
import { VectorStoreService } from "services/vector/main-service";
import { DocumentMetadata } from "services/vector/types";
import { formatSectionPathWithLinks } from "services/document/section-utils";
import { 
  setLastMessageTimestamp, 
  getLastMessageTimestamp,
  setProgressMessageTimestamp,
  getProgressMessageTimestamp,
  deleteProgressMessageTimestamp
} from "services/common";

const suggestUpdatesCallback = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const originalChannelId = body.channel?.id;
    const originalThreadTs = body.container.thread_ts;

    if (!originalChannelId) {
      throw new Error("Channel ID not found");
    }

    // DM 채널 열기
    const dmResult = await client.conversations.open({
      users: userId
    });

    if (!dmResult.ok || !dmResult.channel?.id) {
      throw new Error("DM 채널을 열 수 없습니다");
    }

    const dmChannelId = dmResult.channel.id;

    // 이전 메시지의 버튼들 제거
    const lastMessageTs = getLastMessageTimestamp(userId);
    if (lastMessageTs && dmChannelId) {
      try {
        // 이전 메시지 가져오기
        const history = await client.conversations.history({
          channel: dmChannelId,
          latest: lastMessageTs,
          inclusive: true,
          limit: 1
        });

        if (history.messages && history.messages.length > 0) {
          const previousMessage = history.messages[0];
          if (previousMessage.blocks) {
            // actions 블록을 제외한 나머지 블록만 유지
            const updatedBlocks = previousMessage.blocks.filter((block: any) => 
              block.type !== "actions"
            ) as (KnownBlock | Block)[];

            await client.chat.update({
              channel: dmChannelId,
              ts: lastMessageTs,
              blocks: updatedBlocks,
              text: previousMessage.text || "이전 업데이트 제안"
            });
          }
        }
      } catch (error) {
        console.error("이전 메시지 업데이트 실패:", error);
      }
    }

    // value 파싱
    const value = body.actions?.[0]?.value;
    if (!value) {
      throw new Error("Button value not found");
    }

    const parsedValue = JSON.parse(value);
    let currentIndex = 0;
    let validMessages: SlackMessage[] = [];
    let searchResults: Document<DocumentMetadata>[] = [];
    let isFirstSuggestion = true;

    // 원본 채널 및 스레드 정보 (기본값은 현재 이벤트의 채널과 스레드)
    let contextChannelId = originalChannelId;
    let contextThreadTs = originalThreadTs;

    if (parsedValue) {
      // 원본 채널 및 스레드 정보가 있으면 저장
      if (parsedValue.originalChannelId) {
        contextChannelId = parsedValue.originalChannelId;
      }
      
      if (parsedValue.originalThreadTs) {
        contextThreadTs = parsedValue.originalThreadTs;
      }

      // Next Suggestion 버튼에서 온 경우
      if ("index" in parsedValue) {
        currentIndex = parsedValue.index;
        validMessages = getStoredMessages(parsedValue.messageKeys);
        searchResults = getSearchResults(userId);
        isFirstSuggestion = false;
      } else {
        // 새로운 업데이트 시작인 경우
        if (parsedValue.messageKeys && Array.isArray(parsedValue.messageKeys)) {
          validMessages = getStoredMessages(parsedValue.messageKeys);
        }
      }
    }

    // 메시지가 없는 경우
    if (validMessages.length === 0) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: "Please select messages to update the document. Go back to the original conversation and select messages before trying again.",
      });
      return;
    }

    // DM에 진행 중 메시지 표시
    const progressMessage = await client.chat.postMessage({
      channel: dmChannelId,
      text: "Preparing document update suggestions...",
    });

    // 진행 중 메시지 타임스탬프 저장
    if (progressMessage.ts) {
      setProgressMessageTimestamp(userId, progressMessage.ts);
    }

    // 벡터 스토어 상태 검사
    const healthCheckResult = await checkVectorStoreHealth(client, dmChannelId);
    if (!healthCheckResult.isHealthy) {
      if (healthCheckResult.blocks) {
        await client.chat.postMessage({
          channel: dmChannelId,
          blocks: healthCheckResult.blocks
        });
      } else if (healthCheckResult.message) {
        await client.chat.postMessage({
          channel: dmChannelId,
          text: healthCheckResult.message
        });
      }
      return;
    }

    // 첫 번째 제안인 경우에만 유사도 검색 실행
    const vectorStore = VectorStoreService.getInstance();
    if (currentIndex === 0) {
      // 메타데이터를 활용한 향상된 검색 사용
      searchResults = await vectorStore.smartSearchForMessages(validMessages, 5);

      if (!searchResults || searchResults.length === 0) {
        await client.chat.postMessage({
          channel: dmChannelId,
          text: "No relevant documents found for the selected messages. Please try with different messages or contact an administrator.",
        });
        return;
      }

      // 검색 결과 저장
      storeSearchResults(userId, searchResults);
    }

    // 현재 인덱스의 문서 처리
    if (currentIndex >= searchResults.length) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: "No more documents to update.",
      });
      return;
    }

    const currentDoc = searchResults[currentIndex];
    const processedDoc = await processDocument(currentDoc, validMessages, client, vectorStore);

    if (!processedDoc || !processedDoc.hasChanges) {
      // 진행 중 메시지 삭제
      const progressTs = getProgressMessageTimestamp(userId);
      if (progressTs) {
        try {
          await client.chat.delete({
            channel: dmChannelId,
            ts: progressTs
          });
          deleteProgressMessageTimestamp(userId);
        } catch (deleteError) {
          console.error("진행 중 메시지 삭제 실패:", deleteError);
        }
      }

      // 변경사항이 없는 경우 다음 문서로 넘어감
      await suggestUpdatesCallback({
        ack: async () => {},
        body: {
          ...body,
          actions: [{
            value: JSON.stringify({
              index: currentIndex + 1,
              messageKeys: validMessages.map(msg => `${msg.userId}-${msg.ts}`),
              originalChannelId: contextChannelId,
              originalThreadTs: contextThreadTs
            })
          }]
        },
        client
      } as any);
      return;
    }

    // processedDoc을 DocumentUpdate 형태로 변환
    const documentUpdate: DocumentUpdate = {
      index: currentIndex,
      fileName: processedDoc.fileName,
      githubUrl: processedDoc.githubUrl,
      markdownSection: processedDoc.sectionName || "Main Content",
      headingPath: processedDoc.headingPath,
      hasChanges: processedDoc.hasChanges,
      nodeContent: processedDoc.nodeContent,
      updatedNodeContent: processedDoc.updatedNodeContent,
      diffBlock: processedDoc.diffBlock,
      nodeId: processedDoc.nodeId,
      oldContent: processedDoc.nodeContent,
      newContent: processedDoc.updatedNodeContent,
      messages: validMessages,
      timestamp: new Date().toISOString()
    };

    // 현재 사용자의 document updates 가져오기
    const currentUpdates = getStoredDocumentUpdates(userId);
    
    // 새로운 업데이트 추가 (기존 인덱스 업데이트하거나 새로 추가)
    const existingUpdateIndex = currentUpdates.findIndex(update => update.nodeId === documentUpdate.nodeId);
    if (existingUpdateIndex >= 0) {
      currentUpdates[existingUpdateIndex] = documentUpdate;
    } else {
      currentUpdates.push(documentUpdate);
    }
    
    // 업데이트된 배열 저장
    storeDocumentUpdates(userId, currentUpdates);

    // UI 블록 생성
    const blocks = [];

    // 첫 번째 제안일 때만 헤더 추가
    if (isFirstSuggestion) {
      blocks.push({
        type: "header",
        text: {
          type: "plain_text",
          text: "Suggestions",
          emoji: true
        }
      });
    }

    // 파일 이름과 섹션 정보 추가
    const sectionInfo = formatSectionPathWithLinks({
      headingPath: processedDoc.headingPath,
      sectionName: processedDoc.sectionName,
      githubUrl: processedDoc.githubUrl
    } as DocumentMetadata);
    
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*File:* <${processedDoc.githubUrl}|${processedDoc.fileName}>\n*Section:* ${sectionInfo}`
        }
      },
      processedDoc.diffBlock,
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Edit",
              emoji: true
            },
            action_id: "edit_update",
            value: JSON.stringify({
              index: currentIndex,
              nodeId: processedDoc.nodeId,
              fileName: processedDoc.fileName,
              nodeContent: processedDoc.nodeContent,
              updatedNodeContent: processedDoc.updatedNodeContent
            })
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Keep",
              emoji: true
            },
            style: "primary",
            action_id: "suggest_updates",
            value: JSON.stringify({
              index: currentIndex + 1,
              messageKeys: validMessages.map(msg => `${msg.userId}-${msg.ts}`),
              originalChannelId: contextChannelId,
              originalThreadTs: contextThreadTs,
              action: "keep"
            })
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Discard",
              emoji: true
            },
            style: "danger",
            action_id: "reject_update",
            value: JSON.stringify({
              index: currentIndex + 1,
              messageKeys: validMessages.map(msg => `${msg.userId}-${msg.ts}`),
              originalChannelId: contextChannelId,
              originalThreadTs: contextThreadTs,
              rejectIndex: currentIndex
            })
          }
        ]
      }
    );

    // 사용자 정보 가져오기
    const userInfo = await client.users.info({
      user: userId
    });

    // Manager 여부 확인 (is_admin 또는 is_owner가 true인 경우)
    const isManager = userInfo.user?.is_admin || userInfo.user?.is_owner;

    // 문서 액션 버튼 추가
    const documentActions = {
      type: "actions",
      block_id: "document_actions",
      elements: [] as any[]
    };

    // Manager인 경우에만 Update Documents 버튼 추가
    if (isManager) {
      documentActions.elements.push({
        type: "button",
        text: {
          type: "plain_text",
          text: "Update Documents",
          emoji: true
        },
        style: "primary",
        action_id: "apply_to_document",
        value: JSON.stringify({
          userId: userId,
          originalChannelId: contextChannelId,
          originalThreadTs: contextThreadTs
        })
      });
    }

    // Discuss 버튼 추가 (Manager 여부에 따라 텍스트 변경)
    documentActions.elements.push({
      type: "button",
      text: {
        type: "plain_text",
        text: isManager ? "Discuss with Members" : "Discuss with Managers",
        emoji: true
      },
      action_id: "start_discussion",
      value: JSON.stringify({
        userId: userId,
        stakeholders: Array.from(new Set(validMessages.map(msg => msg.userId))),
        originalChannelId: contextChannelId,
        originalThreadTs: contextThreadTs
      })
    });

    blocks.push(documentActions);

    // DM에 진행 중 메시지가 있다면 삭제
    const progressTs = getProgressMessageTimestamp(userId);
    if (progressTs) {
    try {
      await client.chat.delete({
        channel: dmChannelId,
          ts: progressTs
      });
        deleteProgressMessageTimestamp(userId);
    } catch (deleteError) {
      console.error("진행 중 메시지 삭제 실패:", deleteError);
      }
    }

    // 업데이트 제안 메시지 전송
    const result = await client.chat.postMessage({
      channel: dmChannelId,
      blocks: blocks,
      unfurl_links: false,
      unfurl_media: false,
      text: "Document Update Suggestions"
    });

    // 새로운 메시지의 타임스탬프 저장
    if (result.ts) {
      setLastMessageTimestamp(userId, result.ts);
    }

  } catch (error) {
    console.error("문서 업데이트 제안 중 오류 발생:", error);

    try {
      const dmResult = await client.conversations.open({
        users: body.user.id
      });
      
      if (dmResult.ok && dmResult.channel?.id) {
        await client.chat.postMessage({
          channel: dmResult.channel.id,
          text: `문서 업데이트 제안 중 오류가 발생했습니다: ${
            error instanceof Error ? error.message : "알 수 없는 오류"
          }`
        });
      }
    } catch (dmError) {
      console.error("DM 전송 오류:", dmError);
      
      if (body.channel?.id) {
        await client.chat.postEphemeral({
          channel: body.channel.id,
          user: body.user.id,
          text: `문서 업데이트 제안 중 오류가 발생했습니다: ${
            error instanceof Error ? error.message : "알 수 없는 오류"
          }`
        });
      }
    }
  }
};

export default suggestUpdatesCallback;
