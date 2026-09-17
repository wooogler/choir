import type { LocaleCatalog } from '../../types';

// Korean overlay for the App Home GitHub connection flow; keys missing here
// fall back to English.
//
// `connectRepo.error.access` is a bare `❌ {reason}` frame: the reason itself is
// produced by `services/github/repository-access` and is still English, so the
// only thing to translate is nothing. It stays listed so the frame does not
// drift if that sentence ever moves into the catalog.
export const appHomeGithub: LocaleCatalog = {
  'appHome.github.connect.title': 'GitHub 연결',
  'appHome.github.connect.intro': '🔐 *GitHub 계정 연결하기*\n\nGitHub 계정을 연결하려면 아래 순서대로 해 주세요:',
  'appHome.github.connect.steps':
    '1. 여기로 이동해요: *{link}*\n2. 이 코드를 입력해요: `{code}`\n3. CHOIR가 GitHub 계정에 접근하도록 승인해요',
  'appHome.github.connect.expiry': { other: '⏰ *코드는 {count}분 뒤에 만료돼요*' },
  'appHome.github.connect.hint': '💡 GitHub에서 승인을 마치면 이 창이 바뀌어요. 그때 닫으면 돼요.',
  'appHome.github.connect.success': '✅ *GitHub 계정을 연결했어요!*\n{name}님, 반가워요. 이 창은 닫아도 돼요.',
  'appHome.github.connect.successNotice': '✅ GitHub 계정을 연결했어요! {name}님, 반가워요!',
  'appHome.github.connect.failure': '❌ *GitHub 연결에 실패했어요.*\n이 창을 닫고 다시 시도해 주세요.',
  'appHome.github.connect.failureNotice': '❌ GitHub 연결에 실패했어요. 다시 시도해 주세요.',
  'appHome.github.connect.startError': '❌ GitHub 연결을 시작하지 못했어요. 다시 시도해 주세요.',

  'appHome.github.disconnect.success': '✅ GitHub 계정 연결을 해제했어요.',
  'appHome.github.disconnect.error': '❌ GitHub 연결을 해제하지 못했어요. 다시 시도해 주세요.',

  'appHome.github.repoPicker.title': '저장소 선택',
  'appHome.github.repoPicker.submit': '저장소 연결',
  'appHome.github.repoPicker.notConnected': '❌ 먼저 GitHub 계정을 연결해 주세요.',
  'appHome.github.repoPicker.loading':
    '⏳ *저장소를 불러오고 있어요*\n\n쓰기 권한이 있는 저장소와 `.md` 파일이 들어 있는 저장소를 확인하는 중이에요...',
  'appHome.github.repoPicker.intro':
    '📂 *연결할 GitHub 저장소를 골라 주세요*\n\n쓰기 권한이 있는 공개 저장소를 고르거나, 아래에 공개 GitHub 저장소 URL을 붙여넣어 주세요. 비공개 저장소는 지원하지 않아요.',
  'appHome.github.repoPicker.select.label': '저장소',
  'appHome.github.repoPicker.select.placeholder': '저장소를 골라 주세요...',
  'appHome.github.repoPicker.url.label': '저장소 URL',
  'appHome.github.repoPicker.url.placeholder': '{example} 또는 /tree/branch/docs',
  'appHome.github.repoPicker.path.label': '저장소 안 경로',
  'appHome.github.repoPicker.path.placeholder': 'docs/ (선택 - 비워 두면 최상위 폴더예요)',
  'appHome.github.repoPicker.option.label': '{name} (md {files}개)',
  'appHome.github.repoPicker.option.description': { other: '마크다운 파일 {count}개 · 전체 {total}개 중 {percent}%' },
  'appHome.github.repoPicker.empty': '❌ 쓰기 권한이 있고 마크다운 파일이 들어 있는 공개 저장소를 찾지 못했어요.',
  'appHome.github.repoPicker.error': '❌ 저장소를 불러오지 못했어요. 다시 시도해 주세요.',

  'appHome.github.connectRepo.error.permission': '❌ 저장소를 연결할 권한이 없어요.',
  'appHome.github.connectRepo.error.noSelection': '저장소를 고르거나 GitHub 저장소 URL을 붙여넣어 주세요.',
  'appHome.github.connectRepo.error.bothInputs': '저장소 선택과 URL 중 하나만 사용해 주세요.',
  'appHome.github.connectRepo.error.privateRepo': '비공개 저장소는 지원하지 않아요. 공개 저장소를 골라 주세요.',
  'appHome.github.connectRepo.error.invalidUrl': '올바른 GitHub 저장소 URL을 입력해 주세요.',
  'appHome.github.connectRepo.error.access': '❌ {reason}',
  'appHome.github.connectRepo.error.inline': '저장소를 연결하지 못했어요. 다시 시도해 주세요.',
  'appHome.github.connectRepo.error.generic': '❌ 저장소를 연결하지 못했어요. 다시 시도해 주세요.',
  'appHome.github.connectRepo.progress.connecting': '🔗 저장소에 연결하고 문서를 불러오는 중이에요...',
  'appHome.github.connectRepo.progress.loaded': {
    other:
      '📚 {repository}에서 파일 {count}개를 불러왔어요. 이제 Q&A 인덱스를 만들고 있어요. CPU에서는 1~2분 정도 걸릴 수 있어요.',
  },
  'appHome.github.connectRepo.noFiles': '⚠️ 저장소는 연결했지만 마크다운 파일을 찾지 못했어요.',
  'appHome.github.connectRepo.success': {
    other:
      '✅ {repository}에 연결해 파일 {count}개를 불러오고 Q&A 인덱스까지 만들었어요. 이제 CHOIR가 질문에 답할 수 있어요.',
  },
  'appHome.github.connectRepo.indexFailed': {
    other:
      '⚠️ 저장소를 연결하고 파일 {count}개를 불러왔지만 Q&A 인덱스를 만들지 못했어요. 앱 홈에서 QMD 인덱스를 다시 만들기 전까지는 Q&A를 쓸 수 없어요.',
  },
  'appHome.github.connectRepo.loadFailed': '⚠️ 저장소는 연결했지만 문서를 불러오지 못했어요. 새로고침해 주세요.',
};
