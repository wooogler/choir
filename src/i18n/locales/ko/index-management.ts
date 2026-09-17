import type { LocaleCatalog } from '../../types';

// Korean overlay for the App Home index-management buttons; keys missing here
// fall back to English.
//
// These are the longest-running things a manager can start from App Home, so
// the progress lines say what is happening *now* (-고 있어요 / -는 중이에요) and
// the result lines close it off (-했어요), which is how a Korean reader tells a
// message that is still unfolding from one that is finished.
export const indexManagement: LocaleCatalog = {
  'indexManagement.shared.error.noRepo': '❌ 연결된 GitHub 저장소가 없어요. 먼저 저장소를 연결해 주세요.',
  'indexManagement.shared.error.noMarkdownFiles': '❌ 저장소에서 마크다운 파일을 찾지 못했어요.',

  'indexManagement.reload.error.permission': '❌ GitHub에서 다시 불러올 권한이 없어요.',
  'indexManagement.reload.progress.start': '🔄 GitHub에서 파일을 다시 불러오고 있어요...',
  'indexManagement.reload.success': {
    other: '✅ GitHub에서 파일 {count}개를 다시 불러오고 벡터 스토어를 업데이트했어요!',
  },
  'indexManagement.reload.error.vectorStore': '❌ 새 파일로 벡터 스토어를 업데이트하지 못했어요. 로그를 확인해 주세요.',
  'indexManagement.reload.error.generic': '❌ GitHub에서 다시 불러오는 중에 문제가 생겼어요.',

  'indexManagement.rebuild.error.permission': '❌ QMD 인덱스를 다시 만들 권한이 없어요.',
  'indexManagement.rebuild.error.noMirror':
    '❌ 동기화된 마크다운 미러가 아직 없어요. 먼저 GitHub에서 다시 불러오기를 실행해 주세요.',
  'indexManagement.rebuild.progress.fallback': '♻️ 로컬 마크다운 미러로 QMD 인덱스를 다시 만들고 있어요...',
  'indexManagement.rebuild.progress.start':
    '♻️ *로컬 마크다운 미러로 QMD 인덱스를 다시 만들고 있어요...*\n\nQMD가 CPU에서 임베딩을 계산하면 1~2분 정도 걸릴 수 있어요. 끝나면 성공이나 오류 메시지를 보내 드릴게요.',
  'indexManagement.rebuild.count.chunks': { other: '청크 {count}개' },
  'indexManagement.rebuild.success.fallback':
    '✅ QMD 인덱스를 다시 만들었어요. {indexed}를 인덱싱하고 {chunks}를 임베딩했어요.',
  'indexManagement.rebuild.success':
    '✅ *QMD 인덱스를 다시 만들었어요*\n*인덱싱:* {indexed}\n*업데이트:* {updated}\n*변경 없음:* {unchanged}\n*삭제:* {removed}\n*임베딩한 문서:* {docs}\n*임베딩한 청크:* {chunks}',
  'indexManagement.rebuild.error.generic': '❌ QMD 인덱스를 다시 만드는 중에 문제가 생겼어요.',

  'indexManagement.normalize.error.permission': '❌ 마크다운 파일을 정리할 권한이 없어요.',
  'indexManagement.normalize.progress.start':
    '🔄 마크다운 파일 정리를 시작할게요...\n파일 수에 따라 시간이 걸릴 수 있어요.',
  'indexManagement.normalize.error.noRepo':
    '❌ 연결된 GitHub 저장소가 없어요. 먼저 저장소를 연결하거나 벡터 스토어에 파일이 불러와져 있는지 확인해 주세요.',
  'indexManagement.normalize.progress.found': {
    other: '📄 마크다운 파일 {count}개를 찾았어요. 정리를 시작할게요...',
  },
  'indexManagement.normalize.success': {
    other:
      '✅ 마크다운 파일 {count}개를 정리했어요!\n\n🔄 변경한 내용을 반영하려고 벡터 스토어를 다시 만들고 있어요...',
  },
  'indexManagement.normalize.rebuilt': '✅ 정리한 파일로 벡터 스토어를 다시 만들었어요!',
  'indexManagement.normalize.rebuildFailed':
    '⚠️ 마크다운 정리는 끝났지만 벡터 스토어를 다시 만들지 못했어요. 직접 다시 만들어 주세요.',
  'indexManagement.normalize.count.normalized': { other: '파일 {count}개 정리 완료' },
  'indexManagement.normalize.count.failed': { other: '파일 {count}개 실패' },
  'indexManagement.normalize.partial':
    '⚠️ 정리를 마쳤지만 문제가 있었어요:\n✅ {normalized}\n❌ {failed}\n\n자세한 내용은 로그를 확인해 주세요.',
  'indexManagement.normalize.error.generic': '❌ 마크다운 파일을 정리하는 중에 문제가 생겼어요. 로그를 확인해 주세요.',
};
