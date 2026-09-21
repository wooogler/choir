import {
  type GlossaryLlmClient,
  type GlossaryResponseRequest,
  MAX_CANDIDATES,
  buildExtractionPrompt,
  chunkMarkdown,
  extractGlossaryCandidates,
  parseCandidates,
} from '../services/glossary/extract';
import type { GlossaryEntry } from '../services/glossary/parse';

/**
 * What the model is asked and what is believed of its answer.
 *
 * The rows this proposes land in a table a manager skims, so the two failures
 * that matter are a guessed alias (the alias column is what transcript
 * correction trusts) and a term the glossary already has — the flow is meant to
 * run again on a folder that already has one and show only what is new. The
 * model is faked throughout: this suite is about the prompt, the chunking and
 * the merge, none of which need a network.
 */

const WS = 'T-glossary';

/** Records every request and answers each one with the next scripted reply. */
function fakeClient(replies: string[]): GlossaryLlmClient & { requests: GlossaryResponseRequest[] } {
  const requests: GlossaryResponseRequest[] = [];
  return {
    requests,
    responses: {
      create: async (body: GlossaryResponseRequest) => {
        requests.push(body);
        const reply = replies[requests.length - 1] ?? replies[replies.length - 1] ?? '{"terms":[]}';
        return { output_text: reply };
      },
    },
  };
}

function terms(...list: Array<Record<string, unknown>>): string {
  return JSON.stringify({ terms: list });
}

function entry(term: string, aliases: string[] = []): GlossaryEntry {
  return { term, aliases, description: '', file: 'GLOSSARY.md' };
}

const extract = (
  markdown: string,
  options: { existing?: GlossaryEntry[]; language?: 'ko' | 'en' } = {},
  client?: ReturnType<typeof fakeClient>,
) =>
  extractGlossaryCandidates({
    workspaceId: WS,
    markdown,
    client: client ?? fakeClient([terms({ term: 'RAG', aliases: [], description: 'x', kind: 'acronym' })]),
    model: 'test-model',
    ...options,
  });

describe('the extraction prompt', () => {
  it('asks for the three kinds of term, one-line descriptions, and no guessed aliases', () => {
    const prompt = buildExtractionPrompt({ text: 'The body.' });

    expect(prompt).toContain('acronyms and initialisms together with what they stand for');
    expect(prompt).toContain('named systems, datasets, models, products, tools, teams and projects');
    expect(prompt).toContain('concepts the document itself defines');
    expect(prompt).toContain('Never guess an alias');
    expect(prompt).toContain('at most 140 characters');
    expect(prompt).toContain('Output JSON only');
    expect(prompt).toContain('The body.');
  });

  it('names the language when one was chosen, and stays silent otherwise', () => {
    expect(buildExtractionPrompt({ text: 'x', language: 'ko' })).toContain('Write every `description` in Korean');
    expect(buildExtractionPrompt({ text: 'x' })).not.toContain('Write every `description` in');
  });

  it('lists the terms the glossary already has, under a cap', () => {
    const prompt = buildExtractionPrompt({ text: 'x', existing: [entry('CHOIR'), entry('QMD')] });
    expect(prompt).toContain('already in this glossary — do not list them again: CHOIR, QMD.');

    const many = Array.from({ length: 400 }, (_, index) => entry(`Term-number-${index}`));
    const capped = buildExtractionPrompt({ text: 'x', existing: many });
    expect(capped).toContain('and others.');
    expect(capped.length).toBeLessThan(4000);
  });

  it('is sent with low reasoning effort and a JSON schema', async () => {
    const client = fakeClient([terms({ term: 'RAG', aliases: [], description: 'x', kind: 'acronym' })]);
    await extract('# Paper\n\nRAG means Retrieval-Augmented Generation.', {}, client);

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
      model: 'test-model',
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'glossary_candidates', strict: true } },
    });
  });
});

describe('parsing the answer', () => {
  it('reads a plain object, a bare array and a fenced block alike', () => {
    const row = { term: 'QMD', aliases: ['큐엠디'], description: 'The index', kind: 'proper-noun' };

    expect(parseCandidates(JSON.stringify({ terms: [row] }))).toEqual([
      { term: 'QMD', aliases: ['큐엠디'], description: 'The index', kind: 'proper-noun' },
    ]);
    expect(parseCandidates(JSON.stringify([row]))).toHaveLength(1);
    expect(parseCandidates(`\`\`\`json\n${JSON.stringify({ terms: [row] })}\n\`\`\``)).toHaveLength(1);
    expect(parseCandidates(`Here you go:\n${JSON.stringify({ terms: [row] })}\nHope that helps.`)).toHaveLength(1);
  });

  it('keeps nothing from an answer that is not JSON', () => {
    expect(parseCandidates('I could not find any terms.')).toEqual([]);
    expect(parseCandidates('')).toEqual([]);
    expect(parseCandidates('{"terms": [')).toEqual([]);
  });

  it('drops rows with no term, defaults an unknown kind, and never echoes the term as its own alias', () => {
    const parsed = parseCandidates(
      terms(
        { term: '  ', aliases: [], description: 'nameless', kind: 'concept' },
        { term: 'CHOIR', aliases: ['코이어', 'choir', 'CHOIR', 7], description: 'The bot', kind: 'spaceship' },
      ),
    );

    // `choir` differs from the term only in case, which every lookup already
    // ignores; keeping it would be a column of padding.
    expect(parsed).toEqual([{ term: 'CHOIR', aliases: ['코이어'], description: 'The bot', kind: 'concept' }]);
  });
});

describe('chunking long markdown', () => {
  it('cuts at top-level headings so every chunk belongs to one seed document', () => {
    const chunks = chunkMarkdown('# First paper\n\nBody one.\n\n# Second paper\n\nBody two.\n');

    expect(chunks).toHaveLength(2);
    expect(chunks[0].source).toBe('First paper');
    expect(chunks[0].text).toContain('Body one.');
    expect(chunks[1].source).toBe('Second paper');
    expect(chunks[1].text).not.toContain('Body one.');
  });

  it('ignores a `#` inside a fence', () => {
    const chunks = chunkMarkdown('# Doc\n\n```sh\n# not a heading\n```\n\nBody.\n');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].source).toBe('Doc');
  });

  it('splits a long document at a paragraph boundary once the budget is spent', () => {
    const paragraph = `${'word '.repeat(60)}\n\n`;
    const chunks = chunkMarkdown(`# Long\n\n${paragraph.repeat(40)}`, 300);

    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk still knows which document it came from.
    expect(chunks.every((chunk) => chunk.source === 'Long')).toBe(true);
    // And nothing was dropped on the way.
    expect(
      chunks
        .map((chunk) => chunk.text)
        .join('\n')
        .match(/word/g)?.length,
    ).toBe(60 * 40);
  });

  it('has nothing to say about empty markdown', () => {
    expect(chunkMarkdown('   \n\n  ')).toEqual([]);
  });
});

describe('extractGlossaryCandidates', () => {
  it('calls the model once per chunk and merges what comes back', async () => {
    const client = fakeClient([
      terms({ term: 'RAG', aliases: ['Retrieval-Augmented Generation'], description: 'a', kind: 'acronym' }),
      terms({ term: 'QMD', aliases: [], description: 'b', kind: 'proper-noun' }),
    ]);

    const candidates = await extract('# Paper one\n\nBody.\n\n# Paper two\n\nBody.\n', {}, client);

    expect(client.requests).toHaveLength(2);
    expect(candidates).toEqual([
      {
        term: 'RAG',
        aliases: ['Retrieval-Augmented Generation'],
        description: 'a',
        kind: 'acronym',
        source: 'Paper one',
      },
      { term: 'QMD', aliases: [], description: 'b', kind: 'proper-noun', source: 'Paper two' },
    ]);
  });

  it('merges a term found in two documents instead of proposing it twice', async () => {
    const client = fakeClient([
      terms({ term: 'CHOIR', aliases: ['코이어'], description: 'first', kind: 'proper-noun' }),
      terms({ term: 'choir', aliases: ['콰이어', '코이어'], description: 'second', kind: 'concept' }),
    ]);

    const candidates = await extract('# One\n\nBody.\n\n# Two\n\nBody.\n', {}, client);

    expect(candidates).toHaveLength(1);
    // The first description and kind win; the second document's new alias joins.
    expect(candidates[0]).toMatchObject({
      term: 'CHOIR',
      description: 'first',
      kind: 'proper-noun',
      aliases: ['코이어', '콰이어'],
    });
  });

  it('drops a candidate the glossary already has, by its term or by an alias', async () => {
    const client = fakeClient([
      terms(
        { term: 'choir', aliases: [], description: 'already here', kind: 'proper-noun' },
        { term: 'Retrieval-Augmented Generation', aliases: ['RAG'], description: 'same thing', kind: 'concept' },
        { term: 'QMD', aliases: [], description: 'new', kind: 'proper-noun' },
      ),
    ]);

    const candidates = await extract(
      '# Paper\n\nBody.\n',
      { existing: [entry('CHOIR'), entry('RAG', ['래그'])] },
      client,
    );

    expect(candidates.map((candidate) => candidate.term)).toEqual(['QMD']);
  });

  it('caps the run so a manager is never handed an unreviewable table', async () => {
    const many = Array.from({ length: 200 }, (_, index) => ({
      term: `Term${index}`,
      aliases: [],
      description: 'x',
      kind: 'concept',
    }));
    const client = fakeClient([terms(...many)]);

    const candidates = await extract('# Paper\n\nBody.\n', {}, client);

    expect(candidates).toHaveLength(MAX_CANDIDATES);
    expect(candidates[0].term).toBe('Term0');
  });

  it('answers nothing, rather than throwing, when the model found no terms', async () => {
    await expect(extract('# Paper\n\nBody.\n', {}, fakeClient(['{"terms":[]}']))).resolves.toEqual([]);
  });

  it('never calls the model for empty markdown', async () => {
    const client = fakeClient(['{"terms":[]}']);
    await expect(extract('   ', {}, client)).resolves.toEqual([]);
    expect(client.requests).toHaveLength(0);
  });
});
