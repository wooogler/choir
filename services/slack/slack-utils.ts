import type { WebClient } from "@slack/web-api";
import { SlackMessage } from "services/slack";


// 메시지를 임시 저장할 Map
const messageStore = new Map<string, SlackMessage>();

// 관리자 권한 저장소
// 워크스페이스 관리자(초기 설정자)는 항상 관리자 권한을 가짐
const managerStore = new Map<string, string[]>();

// Organization name 저장소
const organizationNameStore = new Map<string, string>();

// Organization description 저장소  
const organizationDescriptionStore = new Map<string, string>();

export function storeMessage(message: SlackMessage): string {
  const key = `${message.userId}-${message.ts}`;
  messageStore.set(key, message);
  return key;
}

export function getStoredMessage(key: string): SlackMessage | undefined {
  return messageStore.get(key);
}

export function getStoredMessages(keys: string[]): SlackMessage[] {
  return keys
    .map((key) => getStoredMessage(key))
    .filter((msg): msg is SlackMessage => msg !== undefined);
}

export function extractKeysFromMessages(messages: SlackMessage[]): string[] {
  return messages.map((msg) => `${msg.userId}-${msg.ts}`);
}

/**
 * 사용자가 관리자인지 확인합니다.
 * @param workspaceId 워크스페이스 ID
 * @param userId 확인할 사용자 ID
 * @returns 관리자 여부
 */
export function isManager(workspaceId: string, userId: string): boolean {
  const managers = managerStore.get(workspaceId) || [];
  return managers.includes(userId);
}

/**
 * 워크스페이스의 모든 관리자 목록을 반환합니다.
 * @param workspaceId 워크스페이스 ID
 * @returns 관리자 ID 배열
 */
export function getManagers(workspaceId: string): string[] {
  return managerStore.get(workspaceId) || [];
}

/**
 * 사용자에게 관리자 권한을 부여합니다.
 * @param workspaceId 워크스페이스 ID
 * @param userId 권한을 부여할 사용자 ID
 * @param grantedBy 권한을 부여한 사용자 ID
 * @returns 권한 부여 성공 여부
 */
export function addManager(
  workspaceId: string,
  userId: string,
  grantedBy: string
): boolean {
  if (!isManager(workspaceId, grantedBy)) {
    return false; // 권한 부여자가 관리자가 아니면 실패
  }

  const managers = managerStore.get(workspaceId) || [];
  if (managers.includes(userId)) {
    return true; // 이미 관리자인 경우
  }

  const updatedManagers = [...managers, userId];
  managerStore.set(workspaceId, updatedManagers);
  return true;
}

/**
 * 사용자의 관리자 권한을 제거합니다.
 * @param workspaceId 워크스페이스 ID
 * @param userId 권한을 제거할 사용자 ID
 * @param removedBy 권한을 제거한 사용자 ID
 * @returns 권한 제거 성공 여부
 */
export function removeManager(
  workspaceId: string,
  userId: string,
  removedBy: string
): boolean {
  if (!isManager(workspaceId, removedBy)) {
    return false; // 권한 제거자가 관리자가 아니면 실패
  }

  const managers = managerStore.get(workspaceId) || [];
  if (!managers.includes(userId)) {
    return true; // 이미 관리자가 아닌 경우
  }

  const updatedManagers = managers.filter((id) => id !== userId);
  managerStore.set(workspaceId, updatedManagers);
  return true;
}

/**
 * 워크스페이스에 초기 관리자를 설정합니다.
 * @param workspaceId 워크스페이스 ID
 * @param initialManagerId 초기 관리자 ID
 */
export function setupInitialManager(
  workspaceId: string,
  initialManagerId: string
): void {
  const managers = managerStore.get(workspaceId) || [];
  if (managers.length === 0) {
    managerStore.set(workspaceId, [initialManagerId]);
  }
}

export async function createSlackMessageWithName(
  message: { user?: string; text?: string; ts?: string },
  client: WebClient
): Promise<SlackMessage | null> {
  if (!message.user || !message.text || !message.ts) return null;

  const username = await getUserName(message.user, client);
  return {
    userId: message.user,
    username,
    text: message.text,
    ts: message.ts,
  };
}

export async function formatSlackMessageBlock(message: SlackMessage, truncate: boolean = true) {
  const timestamp = new Date(Number(message.ts) * 1000).toLocaleTimeString();

  // 전체 displayText를 70자로 제한 (truncate가 true인 경우에만)
  const fullDisplayText = `*${message.username || "사용자"}* ${timestamp}\n${message.text}`;
  const displayText = truncate && fullDisplayText.length > 70
      ? fullDisplayText.substring(0, 70) + "..."
      : fullDisplayText;

  // 메시지를 저장하고 키를 반환
  const key = storeMessage(message);

  return {
    text: {
      type: "mrkdwn",
      text: displayText,
    },
    value: key, // 메시지 키만 전달
  };
}

export async function getUserName(
  userId: string,
  client: WebClient
): Promise<string> {
  try {
    const userInfo = await client.users.info({ user: userId });

    // 봇 계정인 경우 특별 처리
    if (userInfo.user?.is_bot) {
      // 봇의 이름 반환 (real_name 또는 name 속성 사용)
      return userInfo.user?.real_name || userInfo.user?.name || "Bot";
    }

    // 일반 사용자의 경우 기존 로직 유지
    return userInfo.user?.real_name ?? userInfo.user?.name ?? "Unknown";
  } catch (error) {
    console.error(`유저 정보를 가져오는 중 오류 발생: ${userId}`, error);
    return "Unknown";
  }
}

export async function replaceUserMentions(
  text: string,
  client: WebClient
): Promise<string> {
  const mentionPattern = /<@([A-Z0-9]+)>/g;
  const mentions = [...text.matchAll(mentionPattern)];

  let processedText = text;
  for (const mention of mentions) {
    const userId = mention[1];
    const userName = await getUserName(userId, client);
    processedText = processedText.replace(mention[0], `@${userName}`);
  }

  return processedText;
}

/**
 * 사용자가 워크스페이스의 소유자인지 확인합니다.
 * 소유자는 Slack API에서 is_owner 속성으로 확인됩니다.
 * @param userId 확인할 사용자 ID
 * @param client Slack WebClient
 * @returns 소유자 여부
 */
export async function isWorkspaceOwner(
  userId: string,
  client: WebClient
): Promise<boolean> {
  try {
    const userInfo = await client.users.info({ user: userId });
    return userInfo.user?.is_owner === true;
  } catch (error) {
    console.error("Error checking workspace owner status:", error);
    return false;
  }
}

/**
 * 워크스페이스 ID를 가져옵니다.
 * @param client Slack WebClient
 * @returns 워크스페이스 ID
 */
export async function getWorkspaceId(client: WebClient): Promise<string> {
  try {
    // auth.test()는 모든 앱에서 사용 가능한 API로, 추가 스코프 없이 팀 ID 제공
    const authInfo = await client.auth.test();
    return authInfo.team_id || "unknown";
  } catch (error) {
    console.error("Error getting workspace info:", error);
    return "unknown";
  }
}

// GitHub 저장소 정보 저장소
interface GithubRepoInfo {
  owner: string;
  repo: string;
  path: string;
  url: string;
}

const githubRepoStore = new Map<string, GithubRepoInfo>();

// Q&A 채널 저장소
const qaChannelStore = new Map<string, string>();

/**
 * GitHub 저장소 정보를 저장합니다.
 * @param workspaceId 워크스페이스 ID
 * @param repoInfo 저장소 정보
 */
export function storeGithubRepo(
  workspaceId: string,
  repoInfo: GithubRepoInfo
): void {
  githubRepoStore.set(workspaceId, repoInfo);
}

/**
 * GitHub 저장소 정보를 가져옵니다.
 * @param workspaceId 워크스페이스 ID
 * @returns 저장소 정보 또는 undefined
 */
export function getGithubRepo(workspaceId: string): GithubRepoInfo | undefined {
  return githubRepoStore.get(workspaceId);
}

/**
 * Q&A 채널을 설정합니다.
 * @param workspaceId 워크스페이스 ID
 * @param channelId 채널 ID
 */
export function setQAChannel(workspaceId: string, channelId: string): void {
  qaChannelStore.set(workspaceId, channelId);
}

/**
 * Q&A 채널 정보를 가져옵니다.
 * @param workspaceId 워크스페이스 ID
 * @param client Slack WebClient (채널 존재 확인용, 선택사항)
 * @returns 채널 ID 또는 undefined
 */
export async function getQAChannel(workspaceId: string, client?: WebClient): Promise<string | undefined> {
  let qaChannelId = qaChannelStore.get(workspaceId);
  
  // Q&A 채널이 설정되지 않은 경우 기본값으로 #qna 채널 찾기
  if (!qaChannelId && client) {
    try {
      const channelsList = await client.conversations.list({
        types: 'public_channel',
        exclude_archived: true
      });
      
      // #qna 채널 찾기
      const qnaChannel = channelsList.channels?.find(channel => 
        channel.name === 'qna' && !channel.is_archived
      );
      
      if (qnaChannel?.id) {
        // 찾은 #qna 채널을 기본 Q&A 채널로 설정
        setQAChannel(workspaceId, qnaChannel.id);
        qaChannelId = qnaChannel.id;
      }
    } catch (error) {
      console.error("Error finding default qna channel:", error);
    }
  }
  
  return qaChannelId;
}

/**
 * Organization name을 설정합니다.
 * @param workspaceId 워크스페이스 ID
 * @param name 조직 이름
 */
export function setOrganizationName(workspaceId: string, name: string): void {
  organizationNameStore.set(workspaceId, name);
}

/**
 * Organization name을 가져옵니다.
 * @param workspaceId 워크스페이스 ID
 * @returns 조직 이름 또는 null
 */
export function getOrganizationName(workspaceId: string): string | null {
  return organizationNameStore.get(workspaceId) || null;
}

/**
 * Organization description을 설정합니다.
 * @param workspaceId 워크스페이스 ID
 * @param description 조직 설명
 */
export function setOrganizationDescription(workspaceId: string, description: string): void {
  organizationDescriptionStore.set(workspaceId, description);
}

/**
 * Organization description을 가져옵니다.
 * @param workspaceId 워크스페이스 ID
 * @returns 조직 설명 또는 null
 */
export function getOrganizationDescription(workspaceId: string): string | null {
  return organizationDescriptionStore.get(workspaceId) || null;
}

/**
 * GitHub 저장소 URL을 파싱하여 owner, repo, path 정보를 추출합니다.
 * @param url GitHub 저장소 URL
 * @returns 파싱된 저장소 정보
 */
export function parseGithubUrl(url: string): GithubRepoInfo | null {
  try {
    // GitHub URL 형식: https://github.com/{owner}/{repo}/tree/{branch}/{path}
    // 또는 https://github.com/{owner}/{repo}
    const urlObj = new URL(url);

    if (urlObj.hostname !== "github.com") {
      return null;
    }

    const pathSegments = urlObj.pathname
      .split("/")
      .filter((segment) => segment);

    if (pathSegments.length < 2) {
      return null;
    }

    const owner = pathSegments[0];
    const repo = pathSegments[1];

    let path = "";

    // 경로가 있는 경우 (tree/main/path 형식)
    if (pathSegments.length > 3 && pathSegments[2] === "tree") {
      // tree/{branch} 이후의 경로를 추출
      path = pathSegments.slice(4).join("/");
    }

    return {
      owner,
      repo,
      path,
      url,
    };
  } catch (error) {
    console.error("Error parsing GitHub URL:", error);
    return null;
  }
}

// 유저 ID를 유저 이름으로 변환하는 함수
export async function convertUserIdsToNames(
  messages: SlackMessage[],
  client: WebClient
): Promise<SlackMessage[]> {
  const result: SlackMessage[] = [];
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
export async function replaceMentionsInText(
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

// 중복 메시지 제거 함수
export const removeDuplicateMessages = (
  messages: SlackMessage[]
): SlackMessage[] => {
  const uniqueMessages = new Map<string, SlackMessage>();

  // ts를 기준으로 중복 제거 (동일한 시간에 같은 사용자가 같은 내용을 보낸 경우)
  messages.forEach((msg) => {
    const key = `${msg.userId}-${msg.ts}-${msg.text}`;
    if (!uniqueMessages.has(key)) {
      uniqueMessages.set(key, msg);
    }
  });

  // 시간순으로 정렬
  return Array.from(uniqueMessages.values()).sort(
    (a, b) => parseInt(a.ts) - parseInt(b.ts)
  );
};

// Format a timestamp into a human-readable date string
export function formatTimestampToDateString(timestamp: string): string {
  const date = new Date(parseInt(timestamp) * 1000);
  return `${date.getFullYear()}-${(date.getMonth() + 1)
    .toString()
    .padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")} ${date
    .getHours()
    .toString()
    .padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

// 섹션 이름을 GitBook URL 형식으로 변환하는 함수
export function createGitbookSectionLink(sectionName: string, fileName?: string): string {
  if (!sectionName) return "";
  
  // 파일 이름이 없는 경우 기본 URL 반환
  if (!fileName) {
    return `https://choir.gitbook.io/echolab-assets/#${sectionName.toLowerCase().replace(/\s+/g, '-')}`;
  }
  
  // 파일 이름에서 확장자 제거 후 GitBook 형식으로 변환
  const formattedFileName = fileName
    .replace(/\.md$/, '')
    .toLowerCase()
    .replace(/\s+/g, '_');
  
  // 섹션 이름을 GitBook 형식으로 변환
  const formattedSectionName = sectionName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/\./g, '.')  // 마침표 유지
    .replace(/-/g, '-');  // 하이픈 유지
  
  return `https://choir.gitbook.io/echolab-assets/${formattedFileName}#${formattedSectionName}`;
}

/**
 * 사용자가 봇인지 확인합니다.
 * @param userId 확인할 사용자 ID
 * @param client Slack WebClient 인스턴스
 * @returns 봇 여부
 */
export async function isBotUser(userId: string, client: WebClient): Promise<boolean> {
  try {
    const userInfo = await client.users.info({ user: userId });
    return !!userInfo.user?.is_bot;
  } catch (error) {
    console.error(`봇 여부 확인 중 오류 발생: ${userId}`, error);
    return false;
  }
}

/**
 * 채널 ID로부터 클릭 가능한 채널 멘션을 생성합니다.
 * @param channelId 채널 ID
 * @param client Slack WebClient 인스턴스
 * @returns Slack 형식의 채널 멘션 (예: <#C1234|general>)
 */
export async function getChannelName(channelId: string, client: WebClient): Promise<string> {
  try {
    const channelInfo = await client.conversations.info({ channel: channelId });
    return channelInfo.channel?.name ? `<#${channelId}|${channelInfo.channel.name}>` : "this channel";
  } catch (error) {
    console.error(`채널 정보를 가져오는 중 오류 발생: ${channelId}`, error);
    return "this channel";
  }
}

// 전체 메시지를 섹션 블록으로 포맷팅하는 새로운 함수
export async function formatSlackMessageSection(message: SlackMessage) {
  const timestamp = new Date(Number(message.ts) * 1000).toLocaleString();
  const key = storeMessage(message);

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${message.username || "사용자"}* • ${timestamp}\n${message.text}`
    },
    accessory: {
      type: "checkboxes",
      action_id: "select_message",
      options: [
        {
          text: {
            type: "plain_text",
            text: "Select"
          },
          value: key
        }
      ]
    }
  };
}

/**
 * Q&A 채널용 메시지를 생성합니다 (응답 가능 여부에 따라 다른 형식)
 * @param channelName 채널 이름
 * @param questionerId 질문자 ID
 * @param question 질문 내용
 * @param response CHOIR의 응답
 * @returns 메시지 블록 배열
 */
export function createQAChannelMessage(
  channelName: string,
  questionerId: string,
  question: string,
  response: string
) {
  // CHOIR가 답변할 수 없는 경우인지 확인
  const couldNotAnswer = response.includes("I couldn't find this information in our current documentation");
  
  if (couldNotAnswer) {
    // 답변 불가능한 경우
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Hi, #${channelName}\nA team member asked the following question and this was my response.`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Question:*\n\`\`\`${question}\`\`\``
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `However, I was not able to answer the question. Could anyone help?`
        }
      }
    ];
  } else {
    // 답변 가능한 경우
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Hi, #${channelName}\nA team member asked the following question and this was my response.`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Question:*\n\`\`\`${question}\`\`\``
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*My response:*\n\`\`\`${response}\`\`\``
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `The team member has a follow up discussion on my answer. Could anyone help?`
        }
      }
    ];
  }
}

/**
 * Q&A 채널용 미리보기 텍스트를 생성합니다
 * @param channelName 채널 이름
 * @param questionerId 질문자 ID
 * @param question 질문 내용
 * @param response CHOIR의 응답
 * @returns 미리보기 텍스트
 */
export function createQAChannelPreview(
  channelName: string,
  questionerId: string,
  question: string,
  response: string
): string {
  const couldNotAnswer = response.includes("I couldn't find this information in our current documentation");
  
  if (couldNotAnswer) {
    return `Hi, #${channelName}\nA team member asked the following question and this was my response.\n\n*Question:*\n\`\`\`${question}\`\`\`\n\nHowever, I was not able to answer the question. Could anyone help?`;
  } else {
    return `Hi, #${channelName}\nA team member asked the following question and this was my response.\n\n*Question:*\n\`\`\`${question}\`\`\`\n\n*My response:*\n\`\`\`${response}\`\`\`\n\nThe team member has a follow up discussion on my answer. Could anyone help?`;
  }
}

/**
 * 개인 메시지용 블록을 생성합니다 (응답 가능 여부에 따라 다른 형식)
 * @param recipientId 받는 사람 ID
 * @param questionerId 질문자 ID
 * @param question 질문 내용
 * @param response CHOIR의 응답
 * @returns 메시지 블록 배열
 */
export function createPrivateMessage(
  recipientId: string,
  questionerId: string,
  question: string,
  response: string
) {
  // CHOIR가 답변할 수 없는 경우인지 확인
  const couldNotAnswer = response.includes("I couldn't find this information in our current documentation");
  
  if (couldNotAnswer) {
    // 답변 불가능한 경우
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Hi there!\nA team member asked me the following question and shared my response with you.`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Question:*\n\`\`\`${question}\`\`\``
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `However, I was not able to answer the question. The team member would like your help with this question.`
        }
      }
    ];
  } else {
    // 답변 가능한 경우
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Hi there!\nA team member asked me the following question and shared my response with you.`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Question:*\n\`\`\`${question}\`\`\``
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*My response:*\n\`\`\`${response}\`\`\``
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `The team member would like to discuss this with you. Could you help them?`
        }
      }
    ];
  }
}

/**
 * 개인 메시지용 미리보기 텍스트를 생성합니다
 * @param recipientName 받는 사람 이름 (preview에서는 실제 이름 사용)
 * @param questionerName 질문자 이름
 * @param question 질문 내용
 * @param response CHOIR의 응답
 * @returns 미리보기 텍스트
 */
export function createPrivateMessagePreview(
  recipientName: string,
  questionerName: string,
  question: string,
  response: string
): string {
  const couldNotAnswer = response.includes("I couldn't find this information in our current documentation");
  
  if (couldNotAnswer) {
    return `Hi there!\nA team member asked me the following question and shared my response with you.\n\n*Question:*\n\`\`\`${question}\`\`\`\n\nHowever, I was not able to answer the question. The team member would like your help with this question.`;
  } else {
    return `Hi there!\nA team member asked me the following question and shared my response with you.\n\n*Question:*\n\`\`\`${question}\`\`\`\n\n*My response:*\n\`\`\`${response}\`\`\`\n\nThe team member would like to discuss this with you. Could you help them?`;
  }
}
