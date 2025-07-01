import type { Block, KnownBlock } from '@slack/web-api';

export class HomeScreenService {
  static getHomeBlocks(): (KnownBlock | Block)[] {
    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'CHOIR - Your AI Assistant',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Welcome to CHOIR!*\n\nCHOIR is your AI-powered assistant that helps you find information and answer questions.',
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "*How to use CHOIR:*\n\n• Send me a DM to ask questions\n• Mention me in any channel with @CHOIR\n• I'll help you find relevant information and answer your questions",
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Features:*\n\n• Answer questions based on documentation\n• Provide relevant document references\n• Start discussions with team members\n• Help with technical queries',
        },
      },
    ];
  }

  static getHomeView() {
    return {
      type: 'home' as const,
      blocks: this.getHomeBlocks(),
    };
  }
}
