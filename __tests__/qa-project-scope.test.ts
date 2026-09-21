/**
 * The question path, from "which channel was this asked in" to what the answer
 * prompt is given.
 *
 * The two things worth pinning: a channel that belongs to a project searches
 * its folder and gets the project's description and glossary in the prompt,
 * and a channel that does not behaves byte-for-byte as it did before project
 * folders existed.
 */

import type { GlossaryEntry } from 'services/glossary/parse';
import type { ProjectRecord } from 'services/projects/project-index';
import type { RetrievalSearchParams, RetrievalSearchResult } from 'services/retrieval';

const searchParams: RetrievalSearchParams[] = [];
let searchResult: RetrievalSearchResult = { documents: [], widened: false };
let project: ProjectRecord | null = null;
let glossaryEntries: GlossaryEntry[] = [];
const glossaryCalls: Array<{ forPath: string; fileName?: string }> = [];
const answerCalls: unknown[][] = [];

jest.mock('services/slack', () => ({
  getWorkspaceId: async () => 'T1',
  getOrganizationName: async () => 'Acme',
  getOrganizationDescription: async () => 'We build experiment platforms.',
}));

jest.mock('services/document/document-store', () => ({
  clearFileSelectionState: jest.fn(),
}));

jest.mock('services/projects/project-index', () => ({
  resolveProjectForChannel: async () => project,
}));

jest.mock('services/glossary/load', () => ({
  loadGlossary: async (_workspaceId: string, forPath: string, options?: { fileName?: string }) => {
    glossaryCalls.push({ forPath, fileName: options?.fileName });
    return { entries: glossaryEntries, files: [] };
  },
}));

jest.mock('services/llm/qa-service', () => ({
  answerQuestion: async (...args: unknown[]) => {
    answerCalls.push(args);
    return { canAnswer: true, response: 'Three days.' };
  },
}));

jest.mock('services/retrieval', () => {
  const actual = jest.requireActual('services/retrieval');
  return {
    ...actual,
    getRetrievalProvider: () => ({
      name: 'qmd',
      search: async (params: RetrievalSearchParams) => {
        searchParams.push(params);
        return searchResult.documents;
      },
      searchWithMeta: async (params: RetrievalSearchParams) => {
        searchParams.push(params);
        return searchResult;
      },
    }),
  };
});

import { QuestionProcessor } from 'services/qa/question-processor';

const client = { team: { info: async () => ({ team: { name: 'Acme HQ' } }) } };

function projectRecord(overrides: Partial<ProjectRecord['settings']> = {}): ProjectRecord {
  return {
    folder: 'projects/alpha',
    settings: {
      version: 1,
      name: 'Alpha',
      description: 'The experiment platform redesign.',
      channels: ['C0AB12CD3'],
      members: { source: 'channels', curated: [], aliases: {} },
      scope: { retrieval: 'boost', updates: 'folder' },
      meetingsFolder: 'meetings',
      glossary: 'GLOSSARY.md',
      ...overrides,
    },
  };
}

/** The trailing options object `answerQuestion` takes. */
function contextOf(call: unknown[]): { projectDescription?: string; glossaryBlock?: string } | undefined {
  return call[8] as { projectDescription?: string; glossaryBlock?: string } | undefined;
}

beforeEach(() => {
  searchParams.length = 0;
  answerCalls.length = 0;
  glossaryCalls.length = 0;
  project = null;
  glossaryEntries = [];
  searchResult = { documents: [], widened: false };
});

describe('a question from a channel linked to a project', () => {
  it('scopes the search to the project folder', async () => {
    project = projectRecord();

    await new QuestionProcessor().processQuestion('How long is the trial?', [], client, console, 'U1', 'C0AB12CD3');

    expect(searchParams[0].scope).toEqual({
      pathPrefixes: ['projects/alpha/'],
      mode: 'boost',
      includeRootFiles: true,
    });
  });

  it('passes the exclusive mode through', async () => {
    project = projectRecord({ scope: { retrieval: 'exclusive', updates: 'folder' } });

    await new QuestionProcessor().processQuestion('q', [], client, console, 'U1', 'C0AB12CD3');

    expect(searchParams[0].scope?.mode).toBe('exclusive');
  });

  it('sends no scope at all when the project turned retrieval scoping off', async () => {
    project = projectRecord({ scope: { retrieval: 'off', updates: 'folder' } });

    await new QuestionProcessor().processQuestion('q', [], client, console, 'U1', 'C0AB12CD3');

    expect(searchParams[0].scope).toBeUndefined();
  });

  it("puts the project's description in the answer prompt", async () => {
    project = projectRecord();

    await new QuestionProcessor().processQuestion('q', [], client, console, 'U1', 'C0AB12CD3');

    expect(contextOf(answerCalls[0])?.projectDescription).toBe('The experiment platform redesign.');
  });

  it('reads the glossary chain from the project folder and puts the terms it mentions in the prompt', async () => {
    project = projectRecord();
    glossaryEntries = [
      { term: 'Rollout', aliases: ['배포'], description: 'Shipping a build to users.', source: 'GLOSSARY.md' },
      { term: 'Cohort', aliases: [], description: 'A group in an experiment.', source: 'GLOSSARY.md' },
    ] as unknown as GlossaryEntry[];

    await new QuestionProcessor().processQuestion('When is the rollout?', [], client, console, 'U1', 'C0AB12CD3');

    expect(glossaryCalls[0]).toEqual({ forPath: 'projects/alpha/', fileName: 'GLOSSARY.md' });
    const block = contextOf(answerCalls[0])?.glossaryBlock ?? '';
    expect(block).toContain('Rollout');
    expect(block).toContain('Shipping a build to users.');
  });

  it('uses the glossary file name the project configured', async () => {
    project = projectRecord({ glossary: 'TERMS.md' });

    await new QuestionProcessor().processQuestion('q', [], client, console, 'U1', 'C0AB12CD3');

    expect(glossaryCalls[0].fileName).toBe('TERMS.md');
  });

  it('leaves the glossary block out when the folder chain has no terms', async () => {
    project = projectRecord();

    await new QuestionProcessor().processQuestion('q', [], client, console, 'U1', 'C0AB12CD3');

    expect(contextOf(answerCalls[0])?.glossaryBlock).toBeUndefined();
  });

  it('reports a widened search so the answer can say so', async () => {
    project = projectRecord({ scope: { retrieval: 'exclusive', updates: 'folder' } });
    searchResult = { documents: [], widened: true };

    const result = await new QuestionProcessor().processQuestion('q', [], client, console, 'U1', 'C0AB12CD3');

    expect(result.scopeWidened).toBe(true);
    expect(result.project?.folder).toBe('projects/alpha');
  });
});

describe('a question from an unlinked channel', () => {
  it('searches exactly as it did before project folders: no scope, no project prompt', async () => {
    const result = await new QuestionProcessor().processQuestion('q', [], client, console, 'U1', 'C0ZZZZ');

    expect(searchParams[0]).toEqual({ query: 'q', limit: 5, workspaceId: 'T1' });
    expect(contextOf(answerCalls[0])).toEqual({ projectDescription: undefined, glossaryBlock: undefined });
    expect(glossaryCalls).toHaveLength(0);
    expect(result.scopeWidened).toBe(false);
    expect(result.project).toBeNull();
  });

  it('behaves the same when no channel id is passed at all', async () => {
    await new QuestionProcessor().processQuestion('q', [], client, console, 'U1');

    expect(searchParams[0].scope).toBeUndefined();
    expect(glossaryCalls).toHaveLength(0);
  });

  it('still passes the organization name and description', async () => {
    await new QuestionProcessor().processQuestion('q', [], client, console, 'U1');

    expect(answerCalls[0][5]).toBe('Acme');
    expect(answerCalls[0][6]).toBe('We build experiment platforms.');
  });
});
