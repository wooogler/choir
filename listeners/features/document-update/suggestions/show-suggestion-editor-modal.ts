import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/user-interaction-logger';

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
      throw new Error('버튼 값을 찾을 수 없습니다');
    }

    // 버튼의 value에서 필요한 정보 파싱
    const actionValue = JSON.parse(value);
    const suggestionType = actionValue.suggestionType || 'UPDATE';

    let nodeContent = '';
    let editableContent = '';
    let modalTitle = 'Edit Update Suggestion';
    let originalLabel = '*Original Content:*';
    let editableLabel = 'Updated Content';

    if (suggestionType === 'APPEND') {
      // APPEND의 경우 originalLastNodeContent와 appendedNodeContent 사용
      nodeContent = actionValue.originalLastNodeContent || '';
      editableContent = actionValue.appendedNodeContent || '';
      modalTitle = 'Edit Append Content';
      originalLabel = '*Reference content (will be followed by):*';
      editableLabel = 'New content to add after it';
    } else {
      // UPDATE의 경우 기존 방식 유지
      nodeContent = actionValue.nodeContent || '';
      editableContent = actionValue.updatedNodeContent || '';
    }

    // 필수 값 확인
    if (!nodeContent || !editableContent) {
      console.log('nodeContent', nodeContent);
      console.log('editableContent', editableContent);
      console.log('suggestionType', suggestionType);
      throw new Error('필수 콘텐츠 값이 누락되었습니다');
    }

    // 모달 화면 생성
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'update_editor_submission',
        notify_on_close: true,
        private_metadata: JSON.stringify({
          messageTs: body.message?.ts,
          channelId: body.channel?.id,
          nodeContent,
          editableContent,
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
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: nodeContent,
            },
          },
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
      'unknown',
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
          text: `업데이트 편집기를 열 수 없습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`,
        });
      }
    } catch (dmError) {
      console.error('Error sending error message:', dmError);
    }

    // 로그: 실패
    await logButtonClick(
      body.user.id,
      'unknown',
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
  }
};
