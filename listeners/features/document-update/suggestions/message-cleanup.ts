import { getLastMessageTimestamp } from 'services/common';

export async function stripStaleButtons(
  client: any,
  userId: string,
  dmChannelId: string | undefined,
  messageTs: string | undefined,
  logger: any,
): Promise<void> {
  if (messageTs && dmChannelId) {
    try {
      const history = await client.conversations.history({
        channel: dmChannelId,
        latest: messageTs,
        inclusive: true,
        limit: 1,
      });

      if (history.messages && history.messages.length > 0) {
        const originalMessage = history.messages[0];
        if (originalMessage.blocks) {
          const updatedBlocks = originalMessage.blocks.filter((block: any) => {
            if (block.type === 'actions') return false;
            if (block.type === 'section' && block.text?.text?.startsWith('💡')) return false;
            return true;
          });

          if (updatedBlocks.length < originalMessage.blocks.length) {
            await client.chat.update({
              channel: dmChannelId,
              ts: messageTs,
              text: originalMessage.text || '',
              blocks: updatedBlocks as any,
            });
            logger.info(`Updated message removing buttons ${messageTs} in channel ${dmChannelId}`);
          } else {
            logger.info(`Buttons already removed or not found in message ${messageTs}`);
          }
        }
      }
    } catch (error: any) {
      if (error?.data?.error === 'channel_not_found') {
        logger.info(`Channel not found for message ${messageTs} - likely an anonymous question DM, continuing process`);
      } else {
        logger.error(`Failed to update (remove buttons from) message ${messageTs}:`, error);
      }
    }
  }

  const lastMessageTs = getLastMessageTimestamp(userId);
  if (lastMessageTs && dmChannelId && lastMessageTs !== messageTs) {
    try {
      const history = await client.conversations.history({
        channel: dmChannelId,
        latest: lastMessageTs,
        inclusive: true,
        limit: 1,
      });

      if (history.messages && history.messages.length > 0) {
        const previousMessage = history.messages[0];
        if (previousMessage.blocks) {
          const updatedBlocks = previousMessage.blocks.filter((block: any) => {
            if (block.type === 'actions') return false;
            if (block.type === 'section' && block.text?.text?.startsWith('💡')) return false;
            return true;
          });
          if (updatedBlocks.length < previousMessage.blocks.length) {
            await client.chat.update({
              channel: dmChannelId,
              ts: lastMessageTs,
              text: previousMessage.text || '',
              blocks: updatedBlocks as any,
            });
          }
        }
      }
    } catch (error: any) {
      if (error?.data?.error === 'channel_not_found') {
        console.log(
          'Channel not found for previous suggestion message - likely an anonymous question DM, continuing process',
        );
      } else {
        console.error('Error updating previous suggestion message (removing buttons):', error);
      }
    }
  }
}
