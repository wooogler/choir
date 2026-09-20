import type { DocsApiErrorCode, DocsApiErrorDetail } from 'services/docs-editor/api-errors';

/**
 * A refusal the route can answer with as-is, in the shape
 * `CreateDocumentRefusal` established: an unusable folder, invalid settings, a
 * channel that belongs to somebody else, a Slack scope the workspace never
 * granted. None is a fault; each is something the manager fixes in the dialog.
 *
 * It lives in its own module rather than beside the store so that the Slack
 * directory — which throws these too, and is what the retrieval and
 * meeting-notes work will import — does not pull the GitHub client in behind it.
 * `services/projects/project-store` re-exports it, so callers need not know.
 */
export class ProjectRefusal extends Error {
  readonly status: number;
  readonly apiCode: DocsApiErrorCode;
  readonly detail?: DocsApiErrorDetail;

  constructor(status: number, apiCode: DocsApiErrorCode, detail?: DocsApiErrorDetail) {
    super(apiCode);
    this.name = 'ProjectRefusal';
    this.status = status;
    this.apiCode = apiCode;
    this.detail = detail;
  }
}
