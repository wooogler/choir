import type { T } from '../../../../src/i18n';

/**
 * The example in the URL field's placeholder. It lives here rather than in the
 * catalog because it is a URL: nothing about it is translatable, and a
 * translator who "localised" the host would break the hint.
 */
const REPOSITORY_URL_EXAMPLE = 'https://github.com/owner/repo';

export function formatRepositoryOptionText(
  t: T,
  repo: {
    full_name: string;
    markdownStats?: {
      markdownFiles: number;
    };
  },
): string {
  const markdownFiles = repo.markdownStats?.markdownFiles || 0;
  const text =
    markdownFiles > 0
      ? t('appHome.github.repoPicker.option.label', { name: repo.full_name, files: markdownFiles })
      : repo.full_name;

  // Slack rejects the whole view over 75 characters, and a translated suffix is
  // longer than the English one, so the cap is enforced after interpolation.
  return text.length > 75 ? `${text.slice(0, 72)}...` : text;
}

export function buildRepositoryLoadingView(t: T, metadata: { userId: string; workspaceId: string }) {
  return {
    type: 'modal' as const,
    callback_id: 'select_repository_loading_modal',
    notify_on_close: true,
    title: {
      type: 'plain_text' as const,
      text: t('appHome.github.repoPicker.title'),
    },
    close: {
      type: 'plain_text' as const,
      text: t('common.button.cancel'),
    },
    blocks: [
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: t('appHome.github.repoPicker.loading'),
        },
      },
    ],
    private_metadata: JSON.stringify(metadata),
  };
}

export function buildRepositorySelectionView(
  t: T,
  metadata: { userId: string; workspaceId: string },
  repoOptions: Array<{
    text: {
      type: 'plain_text';
      text: string;
    };
    description?:
      | {
          type: 'plain_text';
          text: string;
        }
      | undefined;
    value: string;
  }>,
) {
  return {
    type: 'modal' as const,
    callback_id: 'select_repository_modal',
    notify_on_close: true,
    title: {
      type: 'plain_text' as const,
      text: t('appHome.github.repoPicker.title'),
    },
    submit: {
      type: 'plain_text' as const,
      text: t('appHome.github.repoPicker.submit'),
    },
    close: {
      type: 'plain_text' as const,
      text: t('common.button.cancel'),
    },
    blocks: [
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: t('appHome.github.repoPicker.intro'),
        },
      },
      {
        type: 'input' as const,
        block_id: 'repository_select_block',
        element: {
          type: 'static_select' as const,
          action_id: 'repository_select',
          placeholder: {
            type: 'plain_text' as const,
            text: t('appHome.github.repoPicker.select.placeholder'),
          },
          options: repoOptions,
        },
        label: {
          type: 'plain_text' as const,
          text: t('appHome.github.repoPicker.select.label'),
        },
        optional: true,
      },
      {
        type: 'input' as const,
        block_id: 'repository_url_block',
        element: {
          type: 'plain_text_input' as const,
          action_id: 'repository_url',
          placeholder: {
            type: 'plain_text' as const,
            text: t('appHome.github.repoPicker.url.placeholder', { example: REPOSITORY_URL_EXAMPLE }),
          },
        },
        label: {
          type: 'plain_text' as const,
          text: t('appHome.github.repoPicker.url.label'),
        },
        optional: true,
      },
      {
        type: 'input' as const,
        block_id: 'path_input_block',
        element: {
          type: 'plain_text_input' as const,
          action_id: 'path_input',
          placeholder: {
            type: 'plain_text' as const,
            text: t('appHome.github.repoPicker.path.placeholder'),
          },
        },
        label: {
          type: 'plain_text' as const,
          text: t('appHome.github.repoPicker.path.label'),
        },
        optional: true,
      },
    ],
    private_metadata: JSON.stringify(metadata),
  };
}

export function buildRepositoryEmptyView(t: T, metadata: { userId: string; workspaceId: string }) {
  return {
    type: 'modal' as const,
    callback_id: 'select_repository_empty_modal',
    notify_on_close: true,
    title: {
      type: 'plain_text' as const,
      text: t('appHome.github.repoPicker.title'),
    },
    close: {
      type: 'plain_text' as const,
      text: t('common.button.close'),
    },
    blocks: [
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: t('appHome.github.repoPicker.empty'),
        },
      },
    ],
    private_metadata: JSON.stringify(metadata),
  };
}
