import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";

const startDiscussionModalCallback = async ({
  ack,
  body,
  view,
  client,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  await ack();

  try {
    const { authors, fileName, githubUrl } = JSON.parse(view.private_metadata);

    // 현재 사용자도 포함
    const allUsers = [body.user.id, ...authors];

    const uniqueUsers = Array.from(new Set(allUsers));

    console.log("uniqueUsers", uniqueUsers);

    // DM 채널 생성
    const result = await client.conversations.open({
      users: uniqueUsers.join(","),
      return_im: true,
    });

    if (!result.channel?.id) {
      throw new Error("Failed to create conversation");
    }

    // DM 채널에 메시지 전송
    await client.chat.postMessage({
      channel: result.channel.id,
      text: `Discussion started about document: <${githubUrl}|${fileName}>`,
    });
  } catch (error) {
    console.error(error);
  }
};

export default startDiscussionModalCallback;
