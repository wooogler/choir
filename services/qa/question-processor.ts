import { Logger } from 'services/common/logger';
import { clearFileSelectionState } from 'services/document/document-store';
// The leaf modules rather than the `services/glossary` barrel: the barrel also
// exports the commit path, which drags Octokit into every Q&A request.
import { loadGlossary } from 'services/glossary/load';
import { glossaryPromptBlock } from 'services/glossary/prompt-block';
import { answerQuestion } from 'services/llm/qa-service';
import type { ProjectRecord } from 'services/projects/project-index';
import { resolveProjectForChannel } from 'services/projects/project-index';
import { getRetrievalProvider, scopeForProject, searchWithMeta } from 'services/retrieval';
import { getOrganizationDescription, getOrganizationName, getWorkspaceId } from 'services/slack';

/**
 * The glossary block rides along with the references and the history, so it
 * gets a smaller budget than a document conversion does: 800 tokens is a few
 * dozen terms, which is every term a single question can plausibly touch.
 */
const GLOSSARY_PROMPT_TOKENS = 800;

export class QuestionProcessor {
  /**
   * `channelId` is how a question finds its project: a channel linked to a
   * project folder searches that folder first (or only), and an unlinked
   * channel — a DM, general chatter — searches the whole repository exactly as
   * it did before (docs/project-folders.md 2 and 3).
   */
  async processQuestion(
    userMessage: string,
    historyMessages: any[],
    client: any,
    logger: any,
    userId?: string,
    channelId?: string,
  ) {
    try {
      Logger.info(
        `QuestionProcessor: Starting to process question: "${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}"`,
      );

      const workspaceId = await getWorkspaceId(client);

      // Q&A 답변 전 document update 캐시 무효화 (최신 정보로 답변하기 위해)
      if (userId) {
        Logger.info(
          `QuestionProcessor: Clearing document update cache for user ${userId} to ensure fresh search results`,
        );
        clearFileSelectionState(userId, workspaceId);
      }

      const project = await this.resolveProject(workspaceId, channelId);
      const scope = project ? scopeForProject(project) : null;

      // Retrieval provider를 통해 관련 문서 가져오기
      const retrievalProvider = getRetrievalProvider();
      Logger.info(`QuestionProcessor: Using retrieval provider "${retrievalProvider.name}"`);

      const { documents: relevantDocs, widened: scopeWidened } = await searchWithMeta(retrievalProvider, {
        query: userMessage,
        limit: 5,
        workspaceId,
        ...(scope ? { scope } : {}),
      });
      Logger.info(`QuestionProcessor: retrieval returned ${relevantDocs.length} documents`, {
        project: project?.folder,
        scope: scope?.mode,
        scopeWidened,
      });

      // 워크스페이스 정보 가져오기
      let workspaceName = '';
      try {
        const teamInfo = await client.team.info();
        workspaceName = teamInfo.team?.name || '';
      } catch (error) {
        Logger.warn('Could not get workspace name', error as Error);
      }

      // Organization 정보 가져오기
      const organizationName = await getOrganizationName(workspaceId);
      const organizationDescription = await getOrganizationDescription(workspaceId);

      // 응답 생성
      const answerResult = await answerQuestion(
        userMessage,
        historyMessages || [],
        relevantDocs,
        client,
        workspaceName,
        organizationName || undefined,
        organizationDescription || undefined,
        workspaceId,
        {
          projectDescription: project?.settings.description || undefined,
          glossaryBlock: await this.glossaryBlockFor(workspaceId, project, userMessage),
        },
      );

      return {
        answerResult,
        relevantDocs,
        workspaceId,
        workspaceName,
        organizationName,
        organizationDescription,
        project,
        scopeWidened,
      };
    } catch (error) {
      Logger.error('Error processing question', error as Error, {
        userMessage: userMessage.substring(0, 100),
      });
      throw error;
    }
  }

  /**
   * A broken project index must never cost someone an answer: without a
   * project the question simply behaves as it did before project folders
   * existed.
   */
  private async resolveProject(workspaceId: string, channelId?: string): Promise<ProjectRecord | null> {
    if (!channelId) return null;

    try {
      return await resolveProjectForChannel(workspaceId, channelId);
    } catch (error) {
      Logger.warn('QuestionProcessor: could not resolve the project for this channel', error as Error);
      return null;
    }
  }

  private async glossaryBlockFor(
    workspaceId: string,
    project: ProjectRecord | null,
    question: string,
  ): Promise<string | undefined> {
    if (!project) return undefined;

    try {
      // The chain from the project folder up to the root, so a project term
      // overrides the organization's and the organization's still applies.
      // Only the basename is configurable: `loadGlossary` looks for one file
      // name per folder in that chain.
      const fileName = project.settings.glossary.split('/').pop() || undefined;
      const { entries } = await loadGlossary(workspaceId, `${project.folder}/`, { fileName });
      return glossaryPromptBlock(entries, { text: question, maxTokens: GLOSSARY_PROMPT_TOKENS }) || undefined;
    } catch (error) {
      Logger.warn('QuestionProcessor: could not load the project glossary', error as Error);
      return undefined;
    }
  }
}
