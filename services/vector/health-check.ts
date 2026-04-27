import type { WebClient } from '@slack/web-api';
import { VectorStoreService } from './main-service';

interface HealthCheckResult {
  isHealthy: boolean;
  message?: string;
  blocks?: any[];
}

export async function checkVectorStoreHealth(
  client: WebClient,
  dmChannelId: string,
  workspaceId?: string,
): Promise<HealthCheckResult> {
  console.log('벡터 스토어 상태 진단 중...');
  const vectorStore = VectorStoreService.getInstance();
  const diagnosis = vectorStore.diagnoseVectorStore(workspaceId);

  // 벡터 스토어에 실제 문제가 있는 경우 (빈 상태가 아닌 오류)
  if (diagnosis.status === 'error' || diagnosis.status === 'degraded') {
    console.log(`벡터 스토어 문제 발견: ${diagnosis.status}, 벡터 수: ${diagnosis.details.vectorsCount}`);

    // 벡터가 완전히 없는 경우, 사용자에게 자동 초기화 옵션 제공
    if (diagnosis.details.vectorsCount === 0) {
      return {
        isHealthy: false,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⚠️ *벡터 스토어에 문제가 발견되었습니다*: ${diagnosis.status}\n\n벡터 스토어 진단을 실행하거나 자동 복구를 시도할 수 있습니다.`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '진단 실행',
                  emoji: true,
                },
                action_id: 'diagnose_vector_store',
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '자동 복구 시도',
                  emoji: true,
                },
                style: 'primary',
                action_id: 'rebuild_vector_cache',
              },
            ],
          },
        ],
      };
    }

    // 벡터에 일부 문제가 있는 경우
    return {
      isHealthy: false,
      message: `⚠️ 벡터 스토어에 문제가 발견되었습니다: ${diagnosis.status}\n\n벡터 스토어 진단을 실행하려면 앱 홈 탭에서 '벡터 스토어 진단' 버튼을 클릭하거나 \`/vector-diagnosis\` 명령어를 실행하세요.`,
    };
  }

  return { isHealthy: true };
}
