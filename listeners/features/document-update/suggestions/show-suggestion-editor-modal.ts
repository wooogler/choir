import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, generateSessionId, storeSessionData } from 'services/common';
import { logButtonClick } from 'services/common/interaction-tracker';
import { getStoredDocumentUpdates } from 'services/document/document-store';
import { getWorkspaceId } from 'services/slack';
import { buildSectionBlocks } from 'services/slack/block-text';

/**
 * 문서 업데이트 제안 편집 모달을 표시합니다.
 */
export const showSuggestionEditorModal = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();

  try {
    // 액션 확인
    await ack();

    // 버튼의 value 확인
    const value = body.actions?.[0]?.value;
    if (!value) {
      throw new Error('Button value not found');
    }

    // 버튼의 value에서 필요한 정보 파싱
    const actionValue = JSON.parse(value);
    const suggestionType = actionValue.suggestionType || 'UPDATE';
    const { index, nodeId } = actionValue;
    const workspaceId = await getWorkspaceId(client);

    // Get stored document updates to retrieve the actual content
    const storedUpdates = getStoredDocumentUpdates(body.user.id, workspaceId);
    const currentUpdate = storedUpdates.find((update) => update.index === index && update.nodeId === nodeId);

    if (!currentUpdate) {
      throw new Error('Document update not found in stored updates');
    }

    let nodeContent = '';
    let editableContent = '';
    const modalTitle = 'Edit Update Suggestion';
    const originalLabel = '*Original Content:*';
    const editableLabel = 'Updated Content';

    // 통일된 UPDATE 방식으로 처리
    nodeContent = currentUpdate.nodeContent || '';
    editableContent = (currentUpdate.updatedNodeContent || '').trim();

    // 필수 값 확인 (빈 섹션의 경우 nodeContent가 빈 문자열일 수 있음)
    if (editableContent === undefined || editableContent === null || !editableContent.trim()) {
      console.log('nodeContent', nodeContent);
      console.log('editableContent', editableContent);
      console.log('suggestionType', suggestionType);
      throw new Error('Required content values are missing');
    }

    // Slack caps private_metadata at 3000 chars, so stash the (potentially large)
    // original content in the session store and reference it by id — a big section
    // otherwise makes views.open fail. (editableContent is not carried at all: the
    // submission reads the user's edit from the input block.)
    const editorSessionId = generateSessionId('suggestion_editor');
    storeSessionData(editorSessionId, { nodeContent }, SessionType.DOCUMENT_UPDATE, 60 * 60 * 1000);

    // 모달 화면 생성
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'update_editor_submission',
        notify_on_close: true,
        private_metadata: JSON.stringify({
          editorSessionId,
          messageTs: body.message?.ts,
          channelId: body.channel?.id,
          suggestionType,
          index: actionValue.index,
          fileName: actionValue.fileName,
          nodeId: actionValue.nodeId,
        }),
        title: {
          type: 'plain_text',
          text: modalTitle,
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: originalLabel,
            },
          },
          // Split the original content across blocks (a section's text is capped
          // at 3000 chars) so a large section still renders. Bound the count so a
          // huge section's preview can't blow past Slack's 100-block modal limit
          // (the editable copy is still fully available in the input below).
          ...buildSectionBlocks(
            nodeContent?.trim() ? nodeContent : '*Empty section - content will be generated*',
            undefined,
            { maxBlocks: 20 },
          ),
          {
            type: 'input',
            block_id: 'updated_content_block',
            label: {
              type: 'plain_text',
              text: editableLabel,
            },
            element: {
              type: 'plain_text_input',
              action_id: 'updated_content_input',
              multiline: true,
              initial_value: editableContent,
            },
          },
        ],
        submit: {
          type: 'plain_text',
          text: 'Save Changes',
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
        },
      },
    });

    // 로그: 성공
    await logButtonClick(
      body.user.id,
      workspaceId,
      body.channel?.id || 'dm',
      'dm',
      'edit_update',
      Date.now() - startTime,
      true,
      {
        suggestionType,
        fileName: actionValue.fileName,
        nodeId: actionValue.nodeId,
        index: actionValue.index,
        nodeContentLength: nodeContent.length,
        editableContentLength: editableContent.length,
        messageTs: body.message?.ts,
        channelId: body.channel?.id,
      },
      client,
    );
  } catch (error) {
    console.error('Error showing update editor modal:', error);

    // 사용자에게 에러 메시지 전송
    try {
      const dmResult = await client.conversations.open({
        users: body.user.id,
      });

      if (dmResult.ok && dmResult.channel?.id) {
        await client.chat.postMessage({
          channel: dmResult.channel.id,
          text: `Cannot open update editor: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    } catch (dmError) {
      console.error('Error sending error message:', dmError);
    }

    // 로그: 실패
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || 'dm',
        'dm',
        'edit_update',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          buttonValue: body.actions?.[0]?.value,
        },
        client,
      );
    } catch (logError) {
      console.error('Failed to log error:', logError);
    }
  }
};
