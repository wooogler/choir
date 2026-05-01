import type { Block, KnownBlock } from '@slack/web-api';
import { SessionType, storeSessionData } from 'services/common';
import { formatSectionPathWithLinks } from 'services/document/section-utils';
import type { ProcessedDocument } from 'services/document/update-processor';
import type { DocumentMetadata } from 'services/file-registry/types';
import { GithubService } from 'services/github';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

export async function buildSuggestionBlocks(params: {
  processedDoc: ProcessedDocument;
  currentIndex: number;
  sessionId: string;
  knowledgeSourceChannelId: string | undefined;
  knowledgeSourceThreadTs: string | undefined;
  userId: string;
  isFirstSuggestion: boolean;
  suggestionNumber: number;
  client: any;
}): Promise<(KnownBlock | Block)[]> {
  const {
    processedDoc,
    currentIndex,
    sessionId,
    knowledgeSourceChannelId,
    knowledgeSourceThreadTs,
    userId,
    isFirstSuggestion,
    suggestionNumber,
    client,
  } = params;

  const sectionInfo = formatSectionPathWithLinks({
    headingPath: processedDoc.headingPath,
    sectionName: processedDoc.sectionName,
    githubUrl: processedDoc.githubUrl,
  } as DocumentMetadata);

  const anchorLineText = processedDoc.updateAnchor?.startLine
    ? processedDoc.updateAnchor.endLine && processedDoc.updateAnchor.endLine !== processedDoc.updateAnchor.startLine
      ? `\nAnchor: lines ${processedDoc.updateAnchor.startLine}-${processedDoc.updateAnchor.endLine}`
      : `\nAnchor: line ${processedDoc.updateAnchor.startLine}`
    : '';

  const suggestionTitleText = `📝 *Update Suggestion ${suggestionNumber}*`;
  const fileInfoText = `File: <${processedDoc.githubUrl}|${processedDoc.fileName}>\nSection: ${sectionInfo}${anchorLineText}`;

  const editButtonValue = {
    index: currentIndex,
    nodeId: processedDoc.nodeId,
    fileName: processedDoc.fileName,
    suggestionType: processedDoc.suggestionType,
    originalChannelId: knowledgeSourceChannelId,
    originalThreadTs: knowledgeSourceThreadTs,
    sessionId,
  };

  const updateButtonValue = {
    index: currentIndex + 1,
    action: 'keep',
    sessionId,
    currentNodeId: processedDoc.nodeId,
  };

  const skipButtonValue = {
    index: currentIndex + 1,
    action: 'skip',
    sessionId,
    currentNodeId: processedDoc.nodeId,
  };

  const cancelButtonValue = {
    userId,
    originalChannelId: knowledgeSourceChannelId,
    originalThreadTs: knowledgeSourceThreadTs,
    index: currentIndex,
    isFirstSuggestion,
    sessionId,
    suggestionType: processedDoc.suggestionType,
  };

  const mainActionButtons = [
    {
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: 'Edit This', emoji: true },
      action_id: 'edit_update',
      value: JSON.stringify(editButtonValue),
    },
    {
      type: 'button' as const,
      text: {
        type: 'plain_text' as const,
        text: processedDoc.hasChanges ? '✅ Apply Changes' : '✅ Looks Good',
        emoji: true,
      },
      style: 'primary' as const,
      action_id: 'suggest_updates',
      value: JSON.stringify(updateButtonValue),
    },
    {
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: '⏭️ Skip This', emoji: true },
      action_id: 'skip_suggestion',
      value: JSON.stringify(skipButtonValue),
    },
    {
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: 'Stop Review', emoji: false },
      style: 'danger' as const,
      action_id: 'cancel_document_updates',
      value: JSON.stringify(cancelButtonValue),
    },
  ];

  const newSectionSuggestion = processedDoc.newSectionSuggestion;
  const newSectionButton = newSectionSuggestion
    ? {
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: '💡 Create New Section', emoji: true },
        action_id: 'create_new_section',
        value: JSON.stringify(
          (() => {
            const newSectionSessionId = `new_section_${userId}_${Date.now()}`;
            storeSessionData(
              newSectionSessionId,
              {
                sectionTitle: newSectionSuggestion.sectionTitle,
                sectionContent: newSectionSuggestion.sectionContent,
                recommendedFile: newSectionSuggestion.recommendedFile,
                reasoning: newSectionSuggestion.reasoning,
                githubUrl: processedDoc.githubUrl,
                originalChannelId: knowledgeSourceChannelId,
                originalThreadTs: knowledgeSourceThreadTs,
                sessionId,
              },
              SessionType.NEW_SECTION,
            );
            return { newSectionSessionId, userId };
          })(),
        ),
      }
    : null;

  let explanationText = '';
  if (processedDoc.hasChanges) {
    explanationText = `📝 I found content that could be *updated* based on your knowledge. I'm showing you the specific changes I'd recommend - you can see exactly what would be modified or added.`;
  } else {
    explanationText = `✅ Great news! This section is already well-aligned with your knowledge. I'm showing you the current content so you can verify it covers what you intended.`;
  }

  const workspaceStore = new WorkspaceStore();
  const config = await workspaceStore.getWorkspaceConfig(await getWorkspaceId(client));
  let directEditUrl = '';
  if (config?.githubRepo) {
    const { owner, repo, branch } = config.githubRepo;
    const branchName =
      branch || (await GithubService.getInstance().getDefaultBranch(owner, repo, await getWorkspaceId(client), userId));
    directEditUrl = `https://github.com/${owner}/${repo}/edit/${branchName}/${processedDoc.fileName}`;
  }

  let bonusIdeaText = '';
  if (processedDoc.newSectionSuggestion) {
    if (processedDoc.hasChanges) {
      bonusIdeaText = `💡 *Other options:* You can create a new section instead of updating this one, or edit ${processedDoc.fileName} directly in GitHub <${directEditUrl}|here>.`;
    } else {
      bonusIdeaText = `💡 *But here's a thought:* Even though this section is already well-aligned, your knowledge might deserve its own dedicated section! I can suggest where and how to create a new section for your content. Check out the "Create New Section" option below!`;
    }
  } else if (processedDoc.hasChanges && directEditUrl) {
    bonusIdeaText = `💡 *Alternative option:* You can edit ${processedDoc.fileName} document in GitHub directly <${directEditUrl}|here>.`;
  }

  const blocks: (KnownBlock | Block)[] = [
    { type: 'divider' },
    {
      type: 'section',
      block_id: createCHOIRBlockId(CHOIRMessageType.DOCUMENT_SUGGESTION),
      text: { type: 'mrkdwn', text: suggestionTitleText },
    },
    { type: 'section', text: { type: 'mrkdwn', text: explanationText } },
    { type: 'section', text: { type: 'mrkdwn', text: fileInfoText } },
    processedDoc.diffBlock,
    { type: 'actions', elements: mainActionButtons },
  ];

  if (bonusIdeaText && newSectionButton) {
    blocks.push(
      { type: 'section', text: { type: 'mrkdwn', text: bonusIdeaText } },
      { type: 'actions', elements: [newSectionButton] },
    );
  }

  blocks.push({ type: 'divider' });

  return blocks;
}
