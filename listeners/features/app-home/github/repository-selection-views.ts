export function formatRepositoryOptionText(repo: {
  full_name: string;
  markdownStats?: {
    markdownFiles: number;
  };
}): string {
  const markdownFiles = repo.markdownStats?.markdownFiles || 0;
  const suffix = markdownFiles > 0 ? ` (${markdownFiles} md)` : '';
  const text = `${repo.full_name}${suffix}`;

  return text.length > 75 ? `${text.slice(0, 72)}...` : text;
}

export function buildRepositoryLoadingView(metadata: { userId: string; workspaceId: string }) {
  return {
    type: 'modal' as const,
    callback_id: 'select_repository_loading_modal',
    notify_on_close: true,
    title: {
      type: 'plain_text' as const,
      text: 'Select Repository',
    },
    close: {
      type: 'plain_text' as const,
      text: 'Cancel',
    },
    blocks: [
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: '⏳ *Loading repositories*\n\nChecking which repositories you can write to and which ones already contain `.md` files...',
        },
      },
    ],
    private_metadata: JSON.stringify(metadata),
  };
}

export function buildRepositorySelectionView(
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
      text: 'Select Repository',
    },
    submit: {
      type: 'plain_text' as const,
      text: 'Connect Repository',
    },
    close: {
      type: 'plain_text' as const,
      text: 'Cancel',
    },
    blocks: [
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: '📂 *Select a GitHub repository to connect*\n\nChoose a public repository you can write to, or paste a public GitHub repository URL below. Private repositories are not supported.',
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
            text: 'Choose a repository...',
          },
          options: repoOptions,
        },
        label: {
          type: 'plain_text' as const,
          text: 'Repository',
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
            text: 'https://github.com/owner/repo or /tree/branch/docs',
          },
        },
        label: {
          type: 'plain_text' as const,
          text: 'Repository URL',
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
            text: 'docs/ (optional - leave empty for root)',
          },
        },
        label: {
          type: 'plain_text' as const,
          text: 'Path in Repository',
        },
        optional: true,
      },
    ],
    private_metadata: JSON.stringify(metadata),
  };
}

export function buildRepositoryEmptyView(metadata: { userId: string; workspaceId: string }) {
  return {
    type: 'modal' as const,
    callback_id: 'select_repository_empty_modal',
    notify_on_close: true,
    title: {
      type: 'plain_text' as const,
      text: 'Select Repository',
    },
    close: {
      type: 'plain_text' as const,
      text: 'Close',
    },
    blocks: [
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: '❌ No public writable repositories with markdown files were found.',
        },
      },
    ],
    private_metadata: JSON.stringify(metadata),
  };
}
