/**
 * Stands in for the GitHub write path while developing the Google Docs review
 * flow, so approving an edit does not need a linked GitHub account with push
 * rights on the docs repo.
 *
 * Approve commits the merged document and then republishes the replica from it.
 * In production the commit goes to GitHub and the mirror catches up through the
 * sync pipeline; here the commit *is* the mirror write, which is what the docs
 * viewer reads.
 */
import crypto from 'node:crypto';

if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
  throw new Error('scripts/dev/fake-github is a development harness and must never load in production');
}

interface CommitFile {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

function install(): void {
  const githubModule = require('services/github/github-service') as {
    default: {
      getInstance(): unknown;
      prototype: Record<string, unknown>;
    };
  };
  const GithubService = githubModule.default;

  // Patched on the prototype rather than the singleton: review-service reaches
  // the class through the `services/github` barrel and app code through the
  // module directly, and both resolve to this same constructor.
  GithubService.prototype.commitFilesWithContext = async (params: {
    files: CommitFile[];
    message: string;
    workspaceId?: string;
  }): Promise<{ commitSha: string }> => {
    const { WorkspaceMirrorService } = require('services/workspace/mirror-service') as {
      WorkspaceMirrorService: {
        getInstance(): { writeMarkdownFile(w: string, p: string, c: string): Promise<string> };
      };
    };

    const workspaceId = params.workspaceId;
    if (!workspaceId) {
      throw new Error('Fake GitHub: commitFilesWithContext needs a workspaceId to write the mirror');
    }

    const mirror = WorkspaceMirrorService.getInstance();
    for (const file of params.files) {
      // Assets ride along base64-encoded; writing them as text would put literal
      // base64 in the mirror. The review loop does not read them back, so skip.
      if (file.encoding === 'base64') continue;
      await mirror.writeMarkdownFile(workspaceId, file.path, file.content);
    }

    const commitSha = crypto
      .createHash('sha1')
      .update(`${params.message}\n${params.files.map((f) => `${f.path}:${f.content}`).join('\n')}`)
      .digest('hex');

    console.log(`[fake-github] commit ${commitSha.slice(0, 7)} — ${params.files.map((f) => f.path).join(', ')}`);
    return { commitSha };
  };

  // The viewer withholds the Edit button, and the save route refuses, unless the
  // signed-in manager's linked GitHub account can push.
  GithubService.prototype.getRepoWriteAccess = async () => ({ connected: true, canPush: true });
}

install();
