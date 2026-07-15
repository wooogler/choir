/**
 * Topic clusterer for the awareness dashboard. Runs as a periodic batch job: it
 * embeds any not-yet-embedded paraphrases, greedily assigns each unassigned event
 * to the nearest existing topic (or opens a new one below a similarity threshold),
 * and (re)labels every topic that gained members via a cheap LLM call.
 *
 * Greedy online clustering keeps already-assigned events stable across runs, so
 * re-running only processes new events. Centroids are computed on the fly from
 * current members (no persisted centroid needed at lab scale).
 */
import { Logger } from 'services/common/logger';
import { createStructuredResponse } from 'services/llm/completions';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { cosineSimilarity, embedBatch, meanVector } from './embeddings';
import {
  type EmbeddedEvent,
  getEmbeddedEvents,
  getEventsNeedingEmbedding,
  insertTopic,
  setEventEmbedding,
  setEventTopic,
  updateTopic,
} from './qa-event-store';

const EMBED_BATCH_SIZE = 100;
const MAX_LABEL_SAMPLES = 20;

function defaultThreshold(): number {
  const raw = Number(process.env.DASHBOARD_TOPIC_SIM_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.8;
}

export type EmbedFn = (texts: string[]) => Promise<number[][]>;
export type LabelFn = (paraphrases: string[]) => Promise<{ label: string; representative: string }>;

export interface ClusterResult {
  embedded: number;
  newTopics: number;
  relabeled: number;
}

const TOPIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', description: '2-5 word topic label' },
    representative: { type: 'string', description: 'one question that best represents the group' },
  },
  required: ['label', 'representative'],
};

/** Default LLM labeler. Never throws — falls back to a heuristic on any failure. */
function makeDefaultLabeler(workspaceId: string): LabelFn {
  return async (paraphrases) => {
    const fallback = () => ({
      label: paraphrases[0].split(/\s+/).slice(0, 6).join(' ').slice(0, 60),
      representative: paraphrases[0],
    });
    try {
      const result = await createStructuredResponse<{ label: string; representative: string }>(
        [
          {
            role: 'system',
            content:
              'You group similar questions into one topic. Given the questions, return a short topic label (2-5 words) and pick or write one representative question capturing the group.',
          },
          { role: 'user', content: paraphrases.map((p, i) => `${i + 1}. ${p}`).join('\n') },
        ],
        {
          workspaceId,
          skipAnonymization: true, // paraphrases are already anonymized; never restore names
          purpose: 'classification',
          temperature: 0,
          max_tokens: 120,
          function_name: 'dashboardTopicLabel',
          schemaName: 'topic',
          schema: TOPIC_SCHEMA,
        },
      );
      const label = result.label?.trim();
      const representative = result.representative?.trim();
      return label && representative ? { label, representative } : fallback();
    } catch (error) {
      Logger.warn('Topic labeler failed; using heuristic label', { workspaceId, error });
      return fallback();
    }
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Clusters one workspace's Q&A events. `opts.embed` / `opts.label` are injectable
 * for tests; `opts.now` supplies the timestamp (Date.now by default).
 */
export async function clusterWorkspace(
  workspaceId: string,
  opts: { embed?: EmbedFn; label?: LabelFn; threshold?: number; now?: number } = {},
): Promise<ClusterResult> {
  const threshold = opts.threshold ?? defaultThreshold();
  const embed = opts.embed ?? ((texts: string[]) => embedBatch(workspaceId, texts));
  const label = opts.label ?? makeDefaultLabeler(workspaceId);
  const now = opts.now ?? Date.now();

  // 1) Embed events that don't have an embedding yet.
  let embedded = 0;
  const pending = getEventsNeedingEmbedding(workspaceId);
  for (const batch of chunk(pending, EMBED_BATCH_SIZE)) {
    const vectors = await embed(batch.map((e) => e.paraphrase));
    for (let i = 0; i < batch.length; i++) {
      if (!vectors[i]) continue;
      setEventEmbedding(batch[i].id, Float32Array.from(vectors[i]));
      embedded++;
    }
  }

  // 2) Load all embedded events.
  const events = getEmbeddedEvents(workspaceId);
  if (events.length === 0) return { embedded, newTopics: 0, relabeled: 0 };

  // 3) Build centroids + member lists from already-assigned events.
  const members = new Map<number, Float32Array[]>();
  const assignment = new Map<number, number>(); // eventId -> topicId
  for (const e of events) {
    if (e.topicId == null) continue;
    assignment.set(e.id, e.topicId);
    if (!members.has(e.topicId)) members.set(e.topicId, []);
    members.get(e.topicId)?.push(e.embedding);
  }
  const centroids = new Map<number, Float32Array>();
  for (const [tid, vecs] of members) centroids.set(tid, meanVector(vecs));

  // 4) Greedily assign each unassigned event.
  const touched = new Set<number>();
  let newTopics = 0;
  for (const e of events) {
    if (e.topicId != null) continue;
    const nearest = nearestTopic(e, centroids);
    if (nearest && nearest.sim >= threshold) {
      assignTo(e, nearest.topicId, { members, centroids, assignment, touched });
    } else {
      const topicId = insertTopic(workspaceId, 'New topic', e.paraphrase, now);
      newTopics++;
      members.set(topicId, []);
      assignTo(e, topicId, { members, centroids, assignment, touched });
    }
  }

  // 5) Relabel every touched topic from its member paraphrases.
  const paraByTopic = new Map<number, string[]>();
  for (const e of events) {
    const tid = assignment.get(e.id);
    if (tid == null) continue;
    if (!paraByTopic.has(tid)) paraByTopic.set(tid, []);
    paraByTopic.get(tid)?.push(e.paraphrase);
  }

  let relabeled = 0;
  for (const tid of touched) {
    const samples = (paraByTopic.get(tid) ?? []).slice(0, MAX_LABEL_SAMPLES);
    if (samples.length === 0) continue;
    const { label: lbl, representative } = await label(samples);
    updateTopic(tid, lbl, representative, now);
    relabeled++;
  }

  return { embedded, newTopics, relabeled };
}

function nearestTopic(
  event: EmbeddedEvent,
  centroids: Map<number, Float32Array>,
): { topicId: number; sim: number } | null {
  let best: { topicId: number; sim: number } | null = null;
  for (const [topicId, centroid] of centroids) {
    const sim = cosineSimilarity(event.embedding, centroid);
    if (!best || sim > best.sim) best = { topicId, sim };
  }
  return best;
}

function assignTo(
  event: EmbeddedEvent,
  topicId: number,
  state: {
    members: Map<number, Float32Array[]>;
    centroids: Map<number, Float32Array>;
    assignment: Map<number, number>;
    touched: Set<number>;
  },
): void {
  setEventTopic(event.id, topicId);
  state.assignment.set(event.id, topicId);
  const memberVecs = state.members.get(topicId) ?? [];
  memberVecs.push(event.embedding);
  state.members.set(topicId, memberVecs);
  state.centroids.set(topicId, meanVector(memberVecs));
  state.touched.add(topicId);
}

/**
 * Clusters every dashboard-enabled workspace. Best-effort per workspace — one
 * failing workspace (e.g. no API key) does not abort the others.
 */
export async function clusterAllWorkspaces(): Promise<void> {
  const configs = await new WorkspaceStore().getAllWorkspaceConfigs();
  for (const config of configs) {
    if (config.dashboardEnabled === false) continue;
    try {
      const result = await clusterWorkspace(config.workspaceId);
      if (result.embedded > 0 || result.newTopics > 0) {
        Logger.info('Dashboard clustering completed', { workspaceId: config.workspaceId, ...result });
      }
    } catch (error) {
      Logger.warn('Dashboard clustering failed for workspace', { workspaceId: config.workspaceId, error });
    }
  }
}
