import type { WebClient } from "@slack/web-api";

export async function getUserName(
  userId: string,
  client: WebClient
): Promise<string> {
  const userInfo = await client.users.info({ user: userId });
  return userInfo.user?.real_name ?? userInfo.user?.name ?? "Unknown";
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
