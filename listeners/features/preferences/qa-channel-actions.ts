import type { AllMiddlewareArgs, App, BlockAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { getChannelName, getWorkspaceId, isManager, isWorkspaceOwner, setQAChannel } from 'services/slack';

// 선택된 채널을 임시 저장할 Map
const selectedChannelStore = new Map<string, string>();

/**
 * Q&A 채널 선택 핸들러
 */
const selectQAChannelCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const workspaceId = await getWorkspaceId(client);

    // 권한 확인
    const isUserManager = isManager(workspaceId, userId);
    const isOwner = await isWorkspaceOwner(userId, client);

    if (!isUserManager && !isOwner) {
      logger.warn(`Unauthorized Q&A channel selection attempt by user ${userId}`);
      return;
    }

    // 선택된 채널 저장
    const action = body.actions[0] as any;
    const selectedChannel = action.selected_channel;

    if (selectedChannel) {
      selectedChannelStore.set(userId, selectedChannel);
      logger.info(`User ${userId} selected channel ${selectedChannel} for Q&A`);
    }
  } catch (error) {
    logger.error('Error handling Q&A channel selection:', error);
  }
};

/**
 * Q&A 채널 설정 핸들러
 */
const setQAChannelCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const workspaceId = await getWorkspaceId(client);

    // 권한 확인
    const isUserManager = isManager(workspaceId, userId);
    const isOwner = await isWorkspaceOwner(userId, client);

    if (!isUserManager && !isOwner) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: userId,
        text: "❌ You don't have permission to set Q&A channel.",
      });
      return;
    }

    // 선택된 채널 가져오기
    const selectedChannelId = selectedChannelStore.get(userId);

    if (!selectedChannelId) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: userId,
        text: '❌ Please select a channel first.',
      });
      return;
    }

    // 채널 접근 가능 여부 및 이름 확인
    let channelName = selectedChannelId;
    try {
      const channelInfo = await client.conversations.info({ channel: selectedChannelId });
      channelName = channelInfo.channel?.name || selectedChannelId;

      // 봇이 채널에 접근할 수 있는지 확인
      if (!channelInfo.channel) {
        throw new Error('Channel not found');
      }
    } catch (channelError: any) {
      logger.warn(`Could not access channel ${selectedChannelId}:`, channelError);

      // 채널에 접근할 수 없는 경우 사용자에게 알림 (DM으로 변경)
      await client.chat.postMessage({
        channel: userId, // 사용자 ID를 채널로 지정하여 DM 발송
        text: `❌ Cannot access the selected channel. Please make sure CHOIR is invited to the channel or select a public channel.`,
      });
      return;
    }

    // Q&A 채널 설정
    setQAChannel(workspaceId, selectedChannelId);

    // 선택된 채널 정보 삭제
    selectedChannelStore.delete(userId);

    // 성공 메시지 (DM으로 변경)
    await client.chat.postMessage({
      channel: userId, // 사용자 ID를 채널로 지정하여 DM 발송
      text: `✅ Q&A channel has been set to #${channelName}. Please refresh the App Home to see the changes.`,
    });

    // App Home 새로고침은 제거 (사용자가 수동으로 새로고침하도록 안내)

    logger.info(`Q&A channel set to ${selectedChannelId} (${channelName}) by user ${userId}`);
  } catch (error) {
    logger.error('Error setting Q&A channel:', error);

    // 에러 메시지 (DM으로 변경)
    await client.chat.postMessage({
      channel: body.user.id, // body.user.id를 사용하여 사용자 ID 가져오기
      text: '❌ Failed to set Q&A channel. Please try again.',
    });
  }
};

const register = (app: App) => {
  app.action('select_qa_channel', selectQAChannelCallback);
  app.action('set_qa_channel', setQAChannelCallback);
};

export default { register };
