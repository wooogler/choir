import type { Block, KnownBlock } from '@slack/web-api';
import { SessionType, generateSessionId, getSessionData, storeSessionData } from 'services/common';
import { formatSectionPathWithLinks } from 'services/document/section-utils';
import type { ProcessedDocument } from 'services/document/update-processor';
import type { DocumentMetadata } from 'services/file-registry/types';
import { GithubService } from 'services/github';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import type { T } from '../../../../../src/i18n';
import { CREATE_FILE_SESSION_EXPIRY, buildStartOverButton } from '../shared';

export async function buildSuggestionBlocks(params: {
  processedDoc: ProcessedDocument;
  currentIndex: number;
  sessionId: string;
  knowledgeContent: string;
  knowledgeSourceChannelId: string | undefined;
  knowledgeSourceThreadTs: string | undefined;
  userId: string;
  isFirstSuggestion: boolean;
  suggestionNumber: number;
  client: any;
  /** The reviewer's translator: this card is a pure view, it resolves nothing. */
  t: T;
}): Promise<(KnownBlock | Block)[]> {
  const {
    processedDoc,
    currentIndex,
    sessionId,
    knowledgeContent,
    knowledgeSourceChannelId,
    knowledgeSourceThreadTs,
    userId,
    isFirstSuggestion,
    suggestionNumber,
    client,
    t,
  } = params;

  const sectionInfo = formatSectionPathWithLinks({
    headingPath: processedDoc.headingPath,
    sectionName: processedDoc.sectionName,
    githubUrl: processedDoc.githubUrl,
  } as DocumentMetadata);

  const anchorLineText = processedDoc.updateAnchor?.startLine
    ? processedDoc.updateAnchor.endLine && processedDoc.updateAnchor.endLine !== processedDoc.updateAnchor.startLine
      ? t('docUpdate.suggestions.card.anchor.range', {
          startLine: processedDoc.updateAnchor.startLine,
          endLine: processedDoc.updateAnchor.endLine,
        })
      : t('docUpdate.suggestions.card.anchor.single', { startLine: processedDoc.updateAnchor.startLine })
    : '';

  const suggestionTitleText = t('docUpdate.suggestions.card.heading', { number: suggestionNumber });
  const fileInfoText = t('docUpdate.suggestions.card.fileInfo', {
    fileLink: `<${processedDoc.githubUrl}|${processedDoc.fileName}>`,
    sectionInfo,
    anchor: anchorLineText,
  });

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
      text: { type: 'plain_text' as const, text: t('docUpdate.suggestions.button.edit'), emoji: true },
      action_id: 'edit_update',
      value: JSON.stringify(editButtonValue),
    },
    {
      type: 'button' as const,
      text: {
        type: 'plain_text' as const,
        text: processedDoc.hasChanges
          ? t('docUpdate.suggestions.button.apply')
          : t('docUpdate.suggestions.button.looksGood'),
        emoji: true,
      },
      style: 'primary' as const,
      action_id: 'suggest_updates',
      value: JSON.stringify(updateButtonValue),
    },
    {
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: t('docUpdate.suggestions.button.skip'), emoji: true },
      action_id: 'skip_suggestion',
      value: JSON.stringify(skipButtonValue),
    },
    {
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: t('docUpdate.suggestions.button.stop'), emoji: false },
      style: 'danger' as const,
      action_id: 'cancel_document_updates',
      value: JSON.stringify(cancelButtonValue),
    },
  ];

  const newSectionSuggestion = processedDoc.newSectionSuggestion;
  const newSectionButton = newSectionSuggestion
    ? {
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: t('docUpdate.suggestions.button.newSection'), emoji: true },
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

  const explanationText = processedDoc.hasChanges
    ? t('docUpdate.suggestions.card.explain.changes')
    : t('docUpdate.suggestions.card.explain.aligned');

  const workspaceStore = new WorkspaceStore();
  const workspaceId = await getWorkspaceId(client);
  const config = await workspaceStore.getWorkspaceConfig(workspaceId);
  let directEditUrl = '';
  if (config?.githubRepo) {
    const { owner, repo, branch } = config.githubRepo;
    const branchName = branch || (await GithubService.getInstance().getDefaultBranch(owner, repo, workspaceId, userId));
    directEditUrl = `https://github.com/${owner}/${repo}/edit/${branchName}/${processedDoc.fileName}`;
  }

  // Item I: inline file switcher — retarget the review to another writable file
  // without a separate selection gate. Carries the review sessionId in block_id
  // so the handler can rebuild context; the option value is the file path.
  const writableFiles = (await workspaceStore.getWritableFilesOrFetch(workspaceId, userId)).slice(0, 100);
  const fileOptions = writableFiles.map((f) => ({
    text: { type: 'plain_text' as const, text: f.name, emoji: false },
    value: f.path,
  }));
  const currentFileOption = fileOptions.find(
    (o) => o.value === processedDoc.fileName || o.text.text === processedDoc.fileName,
  );
  const fileSwitcherBlock =
    fileOptions.length > 0
      ? {
          type: 'section' as const,
          block_id: `file_switcher::${sessionId}`,
          text: { type: 'mrkdwn' as const, text: t('docUpdate.suggestions.fileSwitcher.prompt') },
          accessory: {
            type: 'static_select' as const,
            action_id: 'switch_file_for_review',
            placeholder: { type: 'plain_text' as const, text: t('docUpdate.suggestions.fileSwitcher.placeholder') },
            options: fileOptions,
            ...(currentFileOption && { initial_option: currentFileOption }),
          },
        }
      : null;

  // Item I: "Create New File" moved from the (removed) selection gate onto the
  // suggestion itself. Defaults were prefilled by runInitialSearch into the session.
  const newFileDefaults = (getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any)?.newFileDefaults as
    | { fileName: string; initialContent: string }
    | undefined;
  const createFileSessionId = generateSessionId('create_file');
  storeSessionData(
    createFileSessionId,
    {
      sessionId,
      knowledgeContent,
      knowledgeSourceChannelId,
      knowledgeSourceThreadTs,
      ...(newFileDefaults && {
        defaultFileName: newFileDefaults.fileName,
        defaultInitialContent: newFileDefaults.initialContent,
      }),
    },
    SessionType.CREATE_FILE_MODAL,
    CREATE_FILE_SESSION_EXPIRY,
  );
  const createFileButton = {
    type: 'button' as const,
    text: { type: 'plain_text' as const, text: t('docUpdate.suggestions.button.newFile'), emoji: true },
    action_id: 'show_create_file_modal',
    value: createFileSessionId,
  };

  const editLink = `<${directEditUrl}|${t('docUpdate.suggestions.link.here')}>`;
  let bonusIdeaText = '';
  if (processedDoc.newSectionSuggestion) {
    bonusIdeaText = processedDoc.hasChanges
      ? t('docUpdate.suggestions.bonus.newSectionOrEdit', { fileName: processedDoc.fileName, editLink })
      : t('docUpdate.suggestions.bonus.newSectionOnly');
  } else if (processedDoc.hasChanges && directEditUrl) {
    bonusIdeaText = t('docUpdate.suggestions.bonus.editOnly', { fileName: processedDoc.fileName, editLink });
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

  if (fileSwitcherBlock) {
    blocks.push(fileSwitcherBlock);
  }

  if (bonusIdeaText) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: bonusIdeaText } });
  }

  // "Other options" actions: Create New Section (when offered) + Create New File +
  // Start Over (always) — so the manager can restart the review at any point,
  // including after backing out of a new file/section.
  const extraButtons = [
    ...(newSectionButton ? [newSectionButton] : []),
    createFileButton,
    buildStartOverButton(sessionId, knowledgeSourceChannelId, knowledgeSourceThreadTs, t),
  ];
  blocks.push({ type: 'actions', elements: extraButtons });

  blocks.push({ type: 'divider' });

  return blocks;
}
