import { Document } from "@langchain/core/documents";
import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
  BlockCheckboxesAction,
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
  getStoredEditData,
  parseGithubUrl,
  getUserName,
} from "../../services/slack-utils";
import { VectorStoreService } from "../../services/index";
import GithubService from "../../services/github";
import {
  parseMarkdownToTree,
  treeToMarkdown,
  updateNodeContent,
  type DocumentTree,
  type ExtendedNode,
} from "../../services/markdown";
import { DocumentMetadata } from "../../services/vector/types";
import { WebClient } from "@slack/web-api";

// 선택된 문서 추적을 위한 Map
const selectedDocuments = new Map<string, Set<string>>();

// 사용자의 선택 문서 가져오기
const getSelectedDocuments = (userId: string): string[] => {
  return Array.from(selectedDocuments.get(userId) || new Set<string>());
};

// 유저 ID를 유저 이름으로 변환하는 함수
async function convertUserIdsToNames(
  messages: { text: string; userId: string; ts?: string }[],
  client: WebClient
): Promise<{ text: string; userId: string; username: string; ts?: string }[]> {
  const result: {
    text: string;
    userId: string;
    username: string;
    ts?: string;
  }[] = [];
  const anonymousCounter = new Map<string, number>();

  for (const message of messages) {
    try {
      const username = await getUserName(message.userId, client);
      result.push({
        ...message,
        username,
      });
    } catch (error) {
      console.error(
        `유저 이름을 가져오는 중 오류 발생: ${message.userId}`,
        error
      );

      // 익명 사용자 이름 생성
      let anonymousNumber = anonymousCounter.get(message.userId) || 0;
      if (anonymousNumber === 0) {
        // 새로운 익명 사용자
        anonymousNumber = anonymousCounter.size + 1;
        anonymousCounter.set(message.userId, anonymousNumber);
      }

      result.push({
        ...message,
        username: `Anonymous ${anonymousNumber}`,
      });
    }
  }

  return result;
}

// 메시지 텍스트에서 @멘션을 유저 이름으로 변환하는 함수
async function replaceMentionsInText(
  text: string,
  client: WebClient
): Promise<string> {
  // @멘션 패턴 찾기
  const mentionPattern = /<@([A-Z0-9]+)>/g;
  const mentions = [...text.matchAll(mentionPattern)];

  let processedText = text;

  for (const mention of mentions) {
    const userId = mention[1];
    let username = "Unknown";

    try {
      username = await getUserName(userId, client);
    } catch (error) {
      console.error(
        `멘션된 유저 이름을 가져오는 중 오류 발생: ${userId}`,
        error
      );
    }

    // 멘션을 유저 이름으로 대체
    processedText = processedText.replace(mention[0], `@${username}`);
  }

  return processedText;
}

// 체크박스 액션 핸들러
export const handleDocumentSelection = async ({
  ack,
  body,
  client,
  action,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockCheckboxesAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const channelId = body.channel?.id;

    // 체크박스 값 추출
    const actionValue = action.action_id;
    const optionValue = action.selected_options?.[0]?.value;

    // 값이 있으면 해당 항목만 토글
    if (optionValue) {
      const data = JSON.parse(optionValue);

      // 항목이 선택된 경우 (옵션이 추가됨)
      if (action.selected_options && action.selected_options.length > 0) {
        if (data.editDataKey) {
          // 이미 선택된 목록에 없으면 추가
          if (!selectedDocuments.has(userId)) {
            selectedDocuments.set(userId, new Set<string>());
          }
          selectedDocuments.get(userId)?.add(data.editDataKey);
          console.log(
            `문서 ${data.fileName || "알 수 없는 파일"}이 선택되었습니다.`
          );
        }
      } else {
        // 항목이 선택 해제된 경우 (옵션이 제거됨)
        if (data.editDataKey && selectedDocuments.has(userId)) {
          selectedDocuments.get(userId)?.delete(data.editDataKey);
          console.log(
            `문서 ${data.fileName || "알 수 없는 파일"}이 선택 해제되었습니다.`
          );
        }
      }
    }

    // 현재 선택 상태 로깅
    const selectedKeys = getSelectedDocuments(userId);
    console.log(`현재 선택된 문서 키: ${selectedKeys.join(", ")}`);

    if (channelId) {
      const messageText =
        selectedKeys.length > 0
          ? `${selectedKeys.length}개 문서가 선택되었습니다.`
          : "선택된 문서가 없습니다. 최소 하나의 문서를 선택해주세요.";

      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: messageText,
      });
    }
  } catch (error) {
    console.error("문서 선택 처리 중 오류 발생:", error);
  }
};

// GitHub에 변경사항 적용
export const applySelectedToGithub = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const actionValue = body.actions?.[0]?.value;
    if (!actionValue) {
      throw new Error("액션 값이 없습니다");
    }

    const { editDataKeys } = JSON.parse(actionValue);
    const selectedKeys = getSelectedDocuments(body.user.id);

    console.log("적용 요청된 editDataKeys:", JSON.stringify(editDataKeys));
    console.log("현재 사용자가 선택한 키:", selectedKeys);

    const channelId = body.channel?.id;
    if (!channelId) {
      throw new Error("채널 ID를 찾을 수 없습니다");
    }

    // 선택된 문서가 없는 경우
    if (selectedKeys.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: "선택된 문서가 없습니다. 업데이트할 문서를 선택해주세요.",
      });
      return;
    }

    // 업데이트 진행 중 메시지 전송
    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      text: "선택한 문서를 GitHub에 업데이트 중입니다...",
    });

    // GitHub 서비스 인스턴스 생성
    const githubService = GithubService.getInstance();

    // 결과 저장 배열
    const results: { fileName: string; success: boolean; message: string }[] =
      [];

    // 각 선택된 문서에 대해 GitHub 업데이트 수행
    for (const keyData of editDataKeys) {
      // 선택된 문서만 처리 (키 값 형식 통일)
      const keyToCheck = keyData.key;
      // 체크박스에서 선택한 항목만 업데이트하도록 수정
      const isSelected = selectedKeys.includes(keyToCheck);

      if (isSelected) {
        const editData = getStoredEditData(keyToCheck);
        if (editData) {
          // 디버깅용 로그 추가
          console.log(`[디버깅] 키 ${keyToCheck}에 대한 편집 데이터 처리 중:`);
          console.log(
            `[디버깅] 파일명: ${keyData.fileName}, URL: ${keyData.githubUrl}`
          );
          console.log(
            `[디버깅] 업데이트할 마크다운 길이: ${editData.updatedMarkdown.length} 바이트`
          );
          console.log(
            `[디버깅] 적용할 메시지 수: ${editData.messages.length}개`
          );
          console.log(
            `[디버깅] 선택 상태: ${isSelected ? "선택됨" : "선택되지 않음"}`
          );

          // GitHub URL에서 owner와 repo 추출
          const githubInfo = parseGithubUrl(keyData.githubUrl);
          if (!githubInfo) {
            console.error(`유효한 GitHub URL이 아닙니다: ${keyData.githubUrl}`);
            results.push({
              fileName: keyData.fileName,
              success: false,
              message: `❌ ${keyData.fileName} 파일 업데이트 실패: 유효한 GitHub URL이 아닙니다.`,
            });
            continue;
          }

          // 커밋 메시지 생성 - 업데이트에 사용된 메시지 포함
          const messagesWithUsernames = await convertUserIdsToNames(
            editData.messages,
            client
          );
          const processedMessages = await Promise.all(
            messagesWithUsernames.map(async (msg) => ({
              ...msg,
              text: await replaceMentionsInText(msg.text, client),
              ts: msg.ts || new Date().toISOString(),
            }))
          );

          // JSON 형식의 커밋 메시지 생성
          const commitMessageJson = {
            fileName: keyData.fileName,
            updateType: "document_update",
            source: "choir_app",
            timestamp: new Date().toISOString(),
            messages: processedMessages.map((msg) => ({
              userId: msg.userId,
              username: msg.username,
              text: msg.text,
              ts: msg.ts,
            })),
          };

          try {
            // 실제 GitHub 업데이트 수행
            const result = await githubService.updateMarkdownFile({
              owner: githubInfo.owner,
              repo: githubInfo.repo,
              path: keyData.fileName,
              content: editData.updatedMarkdown,
              message: JSON.stringify(commitMessageJson),
            });

            // 벡터 스토어 재구축
            const vectorStore = VectorStoreService.getInstance();
            await vectorStore.forceRebuildCache();

            console.log(
              `✅ ${keyData.fileName} 파일이 성공적으로 업데이트되었습니다!`
            );
            results.push({
              fileName: keyData.fileName,
              success: true,
              message: `✅ ${keyData.fileName} 파일이 성공적으로 업데이트되었습니다!`,
            });
          } catch (error) {
            console.error(
              `${keyData.fileName} 파일 업데이트 중 오류 발생:`,
              error
            );
            // 더 자세한 오류 정보 로깅
            console.log(`[오류 상세] 에러 타입: ${error?.constructor?.name}`);
            console.log(
              `[오류 상세] 스택 트레이스: ${
                error instanceof Error ? error.stack : "없음"
              }`
            );

            results.push({
              fileName: keyData.fileName,
              success: false,
              message: `❌ ${keyData.fileName} 파일 업데이트 실패: ${
                error instanceof Error ? error.message : "알 수 없는 오류"
              }`,
            });
          }
        } else {
          console.error(`편집 데이터를 찾을 수 없습니다: ${keyToCheck}`);
          results.push({
            fileName: keyData.fileName,
            success: false,
            message: `❌ ${keyData.fileName} 파일 업데이트 실패: 편집 데이터를 찾을 수 없습니다.`,
          });
        }
      }
    }

    // 사용자에게 결과 전송
    const resultMessage =
      results.length > 0
        ? results.map((r) => r.message).join("\n")
        : "선택된 문서가 없습니다.";

    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      text: `*문서 업데이트 결과*\n\n${resultMessage}`,
    });
  } catch (error) {
    console.error("선택한 문서 업데이트 중 오류 발생:", error);

    if (body.channel?.id) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: `문서 업데이트 중 오류가 발생했습니다: ${
          error instanceof Error ? error.message : "알 수 없는 오류"
        }`,
      });
    }
  }
};

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
        // throw new Error("No selected options provided");
        // 에러를 던지는 대신 안내 메시지 전송
        await client.chat.postEphemeral({
          channel: body.channel?.id ?? "",
          user: body.user.id,
          thread_ts: body.container.thread_ts,
          text: "문서 업데이트를 제안하려면 적어도 하나의 메시지를 선택해야 합니다. 메시지를 선택 후 다시 시도해주세요.",
        });
        return; // 기능 종료
      }

      validMessages = getStoredMessages(
        selectedOptions.map((option) => option.value)
      );

      // 메시지가 비어있는 경우 처리
      if (validMessages.length === 0) {
        await client.chat.postEphemeral({
          channel: body.channel?.id ?? "",
          user: body.user.id,
          thread_ts: body.container.thread_ts,
          text: "선택된 메시지가 없거나 메시지를 찾을 수 없습니다. 다시 시도해주세요.",
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
                text: `⚠️ *벡터 스토어에 문제가 발견되었습니다*: ${diagnosis.status}\n\n벡터 스토어 진단 명령어를 실행하거나 자동 복구를 시도할 수 있습니다.`,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "진단 실행",
                    emoji: true,
                  },
                  action_id: "diagnose_vector_store",
                },
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "자동 복구 시도",
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
        text: `⚠️ 벡터 스토어에 문제가 발견되었습니다: ${diagnosis.status}\n\n벡터 스토어 진단을 실행하려면 앱 홈 탭을 열고 '벡터 스토어 진단' 버튼을 클릭하거나, \`/vector-diagnosis\` 명령어를 실행하세요.`,
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
        text: "선택한 메시지와 관련된 문서를 찾을 수 없습니다. 다른 메시지를 선택하거나 관리자에게 문의하세요.\n\n벡터 스토어에 문제가 있는 경우 `/vector-diagnosis` 명령어를 실행하여 진단하고 필요시 복구할 수 있습니다.",
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

    // 각 문서별 결과 저장 배열
    const documentUpdates = [];

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

      // 전체 마크다운 내용과 트리
      const fullMarkdownContent = markdownFile.content;
      let docTree = markdownFile.tree;

      console.log(
        `파일 트리 파싱 완료: 노드 ${docTree.nodeMap.size}개, 섹션 ${docTree.sectionMap.size}개`
      );

      // 이 파일에서 업데이트할 노드들
      let hasAnyChanges = false;

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

        let nodeUpdated = false;
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

            // 노드 내용 변경되었는지 확인
            const hasChanges = nodeContent !== updatedNodeContent;

            if (hasChanges) {
              // 노드 내용만 업데이트
              // updateNodeContent 함수가 이제 새로운 docTree를 반환함
              const updatedDocTree = updateNodeContent(
                docTree,
                nodeId,
                updatedNodeContent
              );

              // 업데이트된 트리가 원본과 다른지 확인
              if (updatedDocTree !== docTree) {
                // 업데이트된 트리로 대체
                docTree = updatedDocTree;
                nodeUpdated = true;
                hasAnyChanges = true;
                console.log(
                  `노드 ID ${nodeId} 업데이트 성공: ${treeToMarkdown(docTree)}`
                );
              } else {
                console.log(
                  `노드 ID ${nodeId} 업데이트 실패 - 지원되지 않는 노드 타입`
                );
              }
            } else {
              console.log(`노드 ID ${nodeId}에 변경사항 없음`);
            }
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
          const diffHasChanges =
            diffBlock.elements &&
            diffBlock.elements.length > 0 &&
            diffBlock.elements[0].elements &&
            diffBlock.elements[0].elements.length > 0;

          documentUpdates.push({
            index: documentUpdates.length,
            fileName,
            githubUrl: group.githubUrl,
            markdownSection,
            hasChanges: nodeUpdated && diffHasChanges,
            // 원래 노드 내용과 업데이트된 노드 내용 저장
            nodeContent,
            updatedNodeContent: updatedNodeContent || nodeContent,
            // diff 화면용
            diffBlock,
            nodeId,
            oldContent: oldSlackText.substring(
              0,
              Math.min(oldSlackText.length, 1500)
            ),
            newContent: newSlackText.substring(
              0,
              Math.min(newSlackText.length, 1500)
            ),
          });
        } catch (error) {
          console.error(`노드 처리 중 오류 발생:`, error);
        }
      }

      // 이 파일의 업데이트된 전체 마크다운 생성
      if (hasAnyChanges) {
        // 수정된 트리를 다시 마크다운으로 변환
        const updatedFullMarkdown = treeToMarkdown(docTree);

        console.log("updatedFullMarkdown", updatedFullMarkdown);

        // 전체 파일에 대한 정보도 저장 (GitHub 업데이트용)
        documentUpdates.push({
          index: -1, // 특수 인덱스로 전체 파일 표시
          fileName,
          githubUrl: group.githubUrl,
          markdownSection: "전체 파일",
          hasChanges: true,
          // 파일 전체 내용 저장
          nodeContent: fullMarkdownContent,
          updatedNodeContent: updatedFullMarkdown,
          updatedFullMarkdown, // 전체 업데이트된 마크다운
          // UI에 표시하지 않음
          diffBlock: { type: "rich_text", elements: [] },
          nodeId: undefined,
          isFullFile: true,
          oldContent: "",
          newContent: "",
        });

        console.log(
          `'${fileName}' 파일 전체 업데이트 준비 완료 (${updatedFullMarkdown.length} 바이트)`
        );
      } else {
        console.log(`'${fileName}' 파일에 변경사항 없음`);
      }
    }

    // 변경사항이 있고 UI에 표시할 문서만 필터링 (전체 파일 업데이트는 제외)
    const documentsWithChanges = documentUpdates.filter(
      (doc) => doc.hasChanges && doc.index >= 0
    );

    // 변경사항이 있는 문서가 없는 경우
    if (documentsWithChanges.length === 0) {
      await client.chat.postEphemeral({
        channel: body.channel?.id ?? "",
        user: body.user.id,
        thread_ts: body.container.thread_ts,
        text: "선택한 메시지로 업데이트할 수 있는 부분이 없습니다. 다른 메시지를 선택하거나 명확한 업데이트 내용을 담고 있는 메시지를 선택해주세요.",
      });
      return;
    }

    // GitHub 업데이트용 전체 파일 정보
    const fullFileUpdates = documentUpdates.filter(
      (doc) => doc.isFullFile && doc.hasChanges
    );

    // 각 문서에 대한 EditData 생성 및 저장
    const editDataKeys = fullFileUpdates.map((doc) => {
      const editData: EditData = {
        fileName: doc.fileName,
        updatedMarkdown: doc.updatedFullMarkdown || doc.updatedNodeContent,
        messages: validMessages,
        diffBlock: { type: "rich_text", elements: [] }, // 전체 파일은 diff 표시 안함
        author: body.user.id,
      };
      return {
        key: storeEditData(editData),
        fileName: doc.fileName,
        githubUrl: doc.githubUrl,
      };
    });

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
    documentsWithChanges.forEach(async (doc, index) => {
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
            text: "이 문서를 업데이트하시겠습니까?",
          },
          accessory: {
            type: "checkboxes",
            action_id: "document_selection",
            options: [
              {
                text: {
                  type: "mrkdwn",
                  text: "업데이트",
                },
                value: JSON.stringify({
                  index: index,
                  editDataKey:
                    editDataKeys[Math.min(index, editDataKeys.length - 1)].key,
                  fileName: doc.fileName,
                  githubUrl: doc.githubUrl,
                }),
              },
            ],
            initial_options: [
              {
                text: {
                  type: "mrkdwn",
                  text: "업데이트",
                },
                value: JSON.stringify({
                  index: index,
                  editDataKey:
                    editDataKeys[Math.min(index, editDataKeys.length - 1)].key,
                  fileName: doc.fileName,
                  githubUrl: doc.githubUrl,
                }),
              },
            ],
          },
        },
        {
          type: "divider",
        }
      );

      // 이전 커밋 정보 가져오기
      try {
        const githubService = GithubService.getInstance();
        const githubInfo = parseGithubUrl(doc.githubUrl);

        if (githubInfo && githubInfo.owner && githubInfo.repo) {
          console.log(`\n----- ${doc.fileName} 파일의 이전 커밋 정보 -----`);

          const commits = await githubService.getHistoryOfMarkdownUpdate({
            owner: githubInfo.owner,
            repo: githubInfo.repo,
            path: doc.fileName,
            newContent: doc.updatedFullMarkdown || doc.updatedNodeContent,
          });

          if (commits.length > 0) {
            console.log(`총 ${commits.length}개의 관련 커밋이 발견되었습니다:`);
            commits.forEach((commit, i) => {
              console.log(`\n[커밋 ${i + 1}]`);
              console.log(`작성자: ${commit.author}`);
              console.log(`날짜: ${commit.date}`);
              console.log(`메시지: ${commit.message}`);
              if (commit.description) {
                console.log(`설명: ${commit.description}`);
              }
            });
          } else {
            console.log("관련 커밋이 없습니다.");
          }
        }
      } catch (error) {
        console.error(
          `${doc.fileName} 파일의 커밋 정보를 가져오는 중 오류 발생:`,
          error
        );
      }
    });

    // 사용자 선택 목록 초기화하고 모든 문서를 기본 선택 상태로 설정
    // 이전 선택 상태를 모두 지우고 새로운 선택 항목으로 초기화
    selectedDocuments.set(body.user.id, new Set<string>());
    // 모든 파일을 기본적으로 선택 상태로 설정
    editDataKeys.forEach((data) => {
      if (data && data.key) {
        selectedDocuments.get(body.user.id)?.add(data.key);
        console.log(
          `파일 키 ${data.key}(${data.fileName})를 기본 선택 목록에 추가했습니다`
        );
      }
    });

    // 현재 선택 상태 로깅
    const currentSelections = getSelectedDocuments(body.user.id);
    console.log(`현재 기본 선택된 문서 키: ${currentSelections.join(", ")}`);

    // 선택한 문서에 대한 액션 버튼
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*선택한 문서에 대한 작업:*",
        },
      },
      {
        type: "actions",
        block_id: "document_actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "GitHub에 적용",
              emoji: true,
            },
            style: "primary",
            action_id: "apply_selected_to_github",
            value: JSON.stringify({
              editDataKeys: editDataKeys.map((data) => ({
                key: data.key,
                fileName: data.fileName,
                githubUrl: data.githubUrl,
              })),
            }),
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "논의 시작",
              emoji: true,
            },
            action_id: "start_discussion",
            value: JSON.stringify({
              stakeholders: uniqueAuthors,
              editDataKeys: editDataKeys.map((data) => data.key),
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
    console.error("Document update suggestion failed:", error);

    // 사용자에게 더 구체적인 오류 메시지 제공
    try {
      await client.chat.postEphemeral({
        channel: body.channel?.id ?? "",
        user: body.user.id,
        thread_ts: body.container?.thread_ts,
        text: `문서 업데이트 제안 중 오류가 발생했습니다: ${
          error instanceof Error ? error.message : "알 수 없는 오류"
        }. 관리자에게 문의하거나 다시 시도해주세요.`,
      });
    } catch (sendError) {
      console.error("Failed to send error message:", sendError);
    }
  }
};

export default suggestUpdatesCallback;
