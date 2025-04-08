import { Document } from "@langchain/core/documents";
import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import { createDiffBlock } from "../../services/slack-diff";
import { editMarkdownWithUserMessages } from "../../services/completions";
import { convertMarkdownToSlackText } from "../../services/markdown";
import {
  getStoredMessages,
  type SlackMessage,
  parseGithubUrl,
  getManagers,
  getWorkspaceId,
} from "../../services/slack-utils";
import { VectorStoreService } from "../../services/index";
import GithubService from "../../services/github";
import { DocumentMetadata } from "../../services/vector/types";
import {
  storeDocumentUpdates,
  setSelectedNodeIds,
  DocumentUpdate,
} from "../../services/document-store";

const suggestUpdatesCallback = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const channelId = body.channel?.id;

    if (!channelId) {
      throw new Error("채널 ID를 찾을 수 없습니다");
    }

    // 워크스페이스 ID 가져오기
    const workspaceId = await getWorkspaceId(client);

    // 관리자 목록 가져오기
    const managers = getManagers(workspaceId);

    // 현재 사용자가 관리자인지 확인
    const isManager = managers.includes(userId);

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
        // throw new Error("No selected options provided");
        // 에러를 던지는 대신 안내 메시지 전송
        await client.chat.postEphemeral({
          channel: body.channel?.id ?? "",
          user: body.user.id,
          thread_ts: body.container.thread_ts,
          text: "You need to select at least one message to suggest document updates. Please select messages and try again.",
        });
        return; // 기능 종료
      }

      // 선택된 옵션의 value는 메시지 키입니다
      const messageKeys = selectedOptions.map((option) => option.value);
      validMessages = getStoredMessages(messageKeys);

      // 메시지가 비어있는 경우 처리
      if (validMessages.length === 0) {
        await client.chat.postEphemeral({
          channel: body.channel?.id ?? "",
          user: body.user.id,
          thread_ts: body.container.thread_ts,
          text: "No messages were selected or messages could not be found. Please try again.",
        });
        return;
      }
    }

    console.log("유효한 메시지 수:", validMessages.length);
    console.log(
      "검색 쿼리:",
      validMessages
        .map((msg) => msg.text)
        .join("\n")
        .substring(0, 100) + "..."
    );

    console.log("벡터 스토어 상태 진단 중...");
    const vectorStore = VectorStoreService.getInstance();
    const diagnosis = vectorStore.diagnoseVectorStore();

    // 벡터 스토어에 문제가 있는 경우 안내 메시지 전송
    if (
      diagnosis.status !== "healthy" ||
      diagnosis.details.vectorsCount === 0
    ) {
      console.log(
        `벡터 스토어 문제 발견: ${diagnosis.status}, 벡터 수: ${diagnosis.details.vectorsCount}`
      );

      // 벡터가 완전히 없는 경우, 사용자에게 자동 초기화 옵션 제공
      if (diagnosis.details.vectorsCount === 0) {
        await client.chat.postEphemeral({
          channel: body.channel?.id ?? "",
          user: body.user.id,
          thread_ts: body.container.thread_ts,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `⚠️ *Vector store issue detected*: ${diagnosis.status}\n\nYou can run the vector store diagnosis command or try automatic recovery.`,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "Run Diagnosis",
                    emoji: true,
                  },
                  action_id: "diagnose_vector_store",
                },
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "Try Automatic Recovery",
                    emoji: true,
                  },
                  style: "primary",
                  action_id: "rebuild_vector_cache",
                },
              ],
            },
          ],
        });
        return;
      }

      // 벡터에 일부 문제가 있는 경우, 진단 명령어 실행 안내
      await client.chat.postEphemeral({
        channel: body.channel?.id ?? "",
        user: body.user.id,
        thread_ts: body.container.thread_ts,
        text: `⚠️ Vector store issue detected: ${diagnosis.status}\n\nTo run vector store diagnosis, open the app home tab and click the 'Vector Store Diagnosis' button, or run the \`/vector-diagnosis\` command.`,
      });
      return;
    }

    // 정상적인 경우 유사도 검색 실행
    console.log("벡터 스토어 상태 정상, 유사도 검색 실행");
    const searchResults = await vectorStore.similaritySearch(
      validMessages.map((msg) => msg.text).join("\n"),
      3
    );

    // 검색 결과가 없는 경우 처리
    if (!searchResults || searchResults.length === 0) {
      await client.chat.postEphemeral({
        channel: body.channel?.id ?? "",
        user: body.user.id,
        thread_ts: body.container.thread_ts,
        text: "No documents found related to the selected messages. Please select different messages or contact an administrator.\n\nIf there's an issue with the vector store, run the `/vector-diagnosis` command to diagnose and recover if needed.",
      });
      return;
    }

    // 상위 3개 문서를 처리 (또는 검색 결과의 모든 문서)
    const topDocuments = searchResults.slice(
      0,
      Math.min(3, searchResults.length)
    );
    console.log(`처리할 상위 문서: ${topDocuments.length}개`);

    // 파일별로 그룹화
    const fileGroups = new Map<
      string,
      {
        documents: Document<DocumentMetadata>[];
        githubUrl: string;
        fileName: string;
      }
    >();

    // 각 문서를 파일별로 그룹화
    for (const doc of topDocuments) {
      if (!doc.metadata?.fileName || !doc.metadata?.githubUrl) {
        console.log(`메타데이터 누락된 문서 건너뜀:`, doc.metadata);
        continue;
      }

      const fileName = doc.metadata.fileName;

      if (!fileGroups.has(fileName)) {
        fileGroups.set(fileName, {
          documents: [],
          githubUrl: doc.metadata.githubUrl,
          fileName: fileName,
        });
      }

      fileGroups.get(fileName)!.documents.push(doc);
    }

    console.log(`파일 그룹 수: ${fileGroups.size}개`);

    // documentUpdates 생성
    const documentUpdates: DocumentUpdate[] = [];

    // GitHub 서비스 인스턴스
    const githubService = GithubService.getInstance();

    // 각 파일별로 처리
    for (const [fileName, group] of fileGroups.entries()) {
      console.log(
        `'${fileName}' 파일 처리 중 (${group.documents.length}개 노드)...`
      );

      // GitHub URL에서 owner와 repo 추출
      const githubInfo = parseGithubUrl(group.githubUrl);
      if (!githubInfo) {
        console.error(`유효한 GitHub URL이 아닙니다: ${group.githubUrl}`);
        continue;
      }

      // VectorStoreService에서 마크다운 파일 가져오기
      const markdownFile = vectorStore.getMarkdownFile(fileName);

      if (!markdownFile) {
        console.error(`파일을 찾을 수 없습니다: ${fileName}`);
        continue;
      }

      let docTree = markdownFile.tree;

      console.log(
        `파일 트리 파싱 완료: 노드 ${docTree.nodeMap.size}개, 섹션 ${docTree.sectionMap.size}개`
      );

      // 각 노드 업데이트 처리 및 결과 저장
      for (let i = 0; i < group.documents.length; i++) {
        const currentDoc = group.documents[i];
        const nodeId = currentDoc.metadata?.nodeId;
        const sectionId = currentDoc.metadata?.sectionId;

        console.log(
          `노드 ${i + 1}/${group.documents.length} 처리 중 - 노드 ID: ${
            nodeId || "없음"
          }, 섹션 ID: ${sectionId || "없음"}`
        );

        // 노드 콘텐츠와 섹션 정보
        const markdownSection =
          currentDoc.metadata?.headingPath?.[0] ||
          currentDoc.metadata?.nodeType ||
          "";

        const nodeContent = currentDoc.pageContent || "";

        let updatedNodeContent = "";

        // 노드 업데이트 시도
        try {
          // 특정 노드 업데이트
          if (nodeId && docTree.nodeMap.has(nodeId)) {
            // 선택된 메시지로 노드 편집
            updatedNodeContent = await editMarkdownWithUserMessages(
              nodeContent,
              validMessages
            );
          } else {
            console.log(`노드 ID가 없거나 트리에서 찾을 수 없음: ${nodeId}`);
          }

          // 노드별 업데이트 정보 저장
          const oldSlackText = await convertMarkdownToSlackText(nodeContent);
          const newSlackText = await convertMarkdownToSlackText(
            updatedNodeContent || nodeContent
          );
          const diffBlock = createDiffBlock(oldSlackText, newSlackText);

          // 변경사항 있는지 확인
          const diffHasChanges = oldSlackText !== newSlackText;

          // 메시지 정보 추출
          const messageInfo = validMessages.map((msg) => ({
            userId: msg.userId,
            text: msg.text,
            ts: msg.ts,
            username: msg.username || "Unknown",
          }));

          // 중복 메시지 제거
          const uniqueMessageInfo = Array.from(
            new Map(
              messageInfo.map((msg) => [
                `${msg.userId}-${msg.ts}-${msg.text}`,
                msg,
              ])
            ).values()
          );

          documentUpdates.push({
            index: documentUpdates.length,
            fileName,
            githubUrl: group.githubUrl,
            markdownSection,
            hasChanges: diffHasChanges,
            // 원래 노드 내용과 업데이트된 노드 내용 저장
            nodeContent,
            updatedNodeContent: updatedNodeContent || nodeContent,
            // diff 화면용
            diffBlock,
            nodeId: nodeId || "",
            oldContent: oldSlackText.substring(
              0,
              Math.min(oldSlackText.length, 1500)
            ),
            newContent: newSlackText.substring(
              0,
              Math.min(newSlackText.length, 1500)
            ),
            // 메시지 정보 추가 (중복 제거된 메시지)
            messages: uniqueMessageInfo,
            // 타임스탬프 추가
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          console.error(`노드 처리 중 오류 발생:`, error);
        }
      }
    }

    // 변경사항이 있고 UI에 표시할 문서만 필터링 (전체 파일 업데이트는 제외)
    const documentUpdatesWithChanges = documentUpdates.filter(
      (doc) => doc.hasChanges && doc.index >= 0
    );

    // 변경사항이 있는 문서가 없는 경우
    if (documentUpdatesWithChanges.length === 0) {
      await client.chat.postEphemeral({
        channel: body.channel?.id ?? "",
        user: body.user.id,
        thread_ts: body.container.thread_ts,
        text: "No parts of the document can be updated with the selected messages. Please select different messages or messages with clear update content.",
      });
      return;
    }

    // documentUpdates 저장
    storeDocumentUpdates(userId, documentUpdates, body.container.thread_ts);

    // 초기 상태에서 모든 문서가 선택되도록 설정
    const initialNodeIds = documentUpdatesWithChanges
      .filter((doc) => doc.nodeId)
      .map((doc) => doc.nodeId!);
    setSelectedNodeIds(userId, initialNodeIds);

    const uniqueAuthors = Array.from(
      new Set(validMessages.map((msg) => msg.userId))
    );

    // 블록 생성
    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Document Updates Suggestions",
          emoji: true,
        },
      },
      {
        type: "divider",
      },
    ];

    // 각 문서에 대한 섹션 추가 (UI 표시용 documentsWithChanges 사용)
    documentUpdatesWithChanges.forEach(async (doc, index) => {
      // 문서 헤더 - "문서 N" 제목 제거
      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*File:* <${doc.githubUrl}|${doc.fileName}>\n*Section:* ${doc.markdownSection}`,
          },
        },
        {
          type: "divider",
        },
        doc.diffBlock,
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Would you like to update this document?",
          },
          accessory: {
            type: "checkboxes",
            action_id: "document_selection",
            options: [
              {
                text: {
                  type: "mrkdwn",
                  text: "Update",
                },
                value: JSON.stringify({
                  index: index,
                  fileName: doc.fileName,
                  githubUrl: doc.githubUrl,
                  nodeId: doc.nodeId,
                }),
              },
            ],
            initial_options: [
              {
                text: {
                  type: "mrkdwn",
                  text: "Update",
                },
                value: JSON.stringify({
                  index: index,
                  fileName: doc.fileName,
                  githubUrl: doc.githubUrl,
                  nodeId: doc.nodeId,
                }),
              },
            ],
          },
        },
        {
          type: "divider",
        }
      );
    });

    // 선택한 문서에 대한 액션 버튼
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Actions for selected documents:*",
        },
      },
      {
        type: "actions",
        block_id: "document_actions",
        elements: [
          ...(isManager
            ? [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "Apply to Document",
                    emoji: true,
                  },
                  style: "primary",
                  action_id: "apply_selected_to_github",
                  value: JSON.stringify({
                    validMessages,
                  }),
                },
              ]
            : []),
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Start Discussion",
              emoji: true,
            },
            action_id: "start_discussion",
            value: JSON.stringify({
              stakeholders: uniqueAuthors,
              validMessages,
            }),
          },
        ],
      }
    );

    // 메시지 전송
    await client.chat.postEphemeral({
      channel: body.channel?.id ?? "",
      user: body.user.id,
      thread_ts: body.container.thread_ts,
      blocks: blocks,
    });
  } catch (error) {
    console.error("문서 업데이트 제안 중 오류 발생:", error);

    if (body.channel?.id) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: `An error occurred while suggesting document updates: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      });
    }
  }
};

export default suggestUpdatesCallback;
