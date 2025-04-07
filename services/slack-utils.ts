import type { WebClient } from "@slack/web-api";
import type { RichTextElement } from "./slack-diff";
export interface SlackMessage {
  userId: string;
  username: string;
  text: string;
  ts: string;
}

export interface EditData {
  fileName: string;
  updatedMarkdown: string;
  messages: SlackMessage[];
  diffBlock: {
    type: string;
    elements: {
      type: string;
      elements: RichTextElement[];
    }[];
  };
  author: string;
  nodeId?: string;
}

// 메시지를 임시 저장할 Map
const messageStore = new Map<string, SlackMessage>();

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

const editStore = new Map<string, EditData>();

export function storeEditData(editData: EditData): string {
  const key = editData.author;
  editStore.set(key, editData);
  return key;
}

export function getStoredEditData(key: string): EditData | undefined {
  return editStore.get(key);
}

// 관리자 권한 저장소
// 워크스페이스 관리자(초기 설정자)는 항상 관리자 권한을 가짐
const managerStore = new Map<string, string[]>();

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

export async function formatSlackMessageBlock(message: SlackMessage) {
  const timestamp = new Date(Number(message.ts) * 1000).toLocaleTimeString();
  const displayText = `*<@${message.userId}>* ${timestamp}\n${message.text}`;
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
