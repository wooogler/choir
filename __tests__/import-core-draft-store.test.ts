import { DraftStore } from '../services/import/draft-store';
import type { ConvertedDocument, ImportAsset } from '../services/import/types';
import { ImportRefusal } from '../services/import/types';

/**
 * The draft store holds someone else's document and someone else's images in
 * this process's memory, so what is tested here is the three ways that goes
 * wrong: it outlives its usefulness, it answers to the wrong person, or it grows
 * without bound.
 */

function asset(path: string, bytes: number): ImportAsset {
  return { path, bytes: Buffer.alloc(bytes), contentType: 'image/png' };
}

function doc(markdown: string, assets: ImportAsset[] = []): ConvertedDocument {
  return {
    markdown,
    title: 'Onboarding',
    assets,
    rejectedAssets: [],
    warnings: [],
    source: { kind: 'pdf', name: 'onboarding.pdf', pages: 12 },
  };
}

const OWNER = { workspaceId: 'T1', userId: 'U1' };

describe('DraftStore', () => {
  it('hands a draft back to the person who made it', () => {
    const store = new DraftStore();
    const { id, expiresAt } = store.create({ ...OWNER, document: doc('# Onboarding\n\nHello') });

    const draft = store.get(id, OWNER);
    expect(draft?.document.markdown).toBe('# Onboarding\n\nHello');
    expect(draft?.expiresAt).toBe(expiresAt);
    expect(store.size()).toBe(1);
    store.dispose();
  });

  it('counts markdown and image bytes together', () => {
    const store = new DraftStore();
    store.create({ ...OWNER, document: doc('abc', [asset('assets/a.png', 100)]) });

    expect(store.totalBytes()).toBe(103);
    store.dispose();
  });

  it('forgets a draft once its TTL has passed', () => {
    let now = 1_000;
    const store = new DraftStore({ ttlMs: 500, now: () => now });
    const { id } = store.create({ ...OWNER, document: doc('body') });

    now = 1_400;
    expect(store.get(id, OWNER)).not.toBeNull();

    now = 1_600;
    expect(store.get(id, OWNER)).toBeNull();
    // Expiry on access also reclaims the memory, not just the answer.
    expect(store.size()).toBe(0);
    store.dispose();
  });

  it('sweeps expired drafts without anyone asking', () => {
    let now = 0;
    const store = new DraftStore({ ttlMs: 100, now: () => now });
    store.create({ ...OWNER, document: doc('one') });
    store.create({ ...OWNER, document: doc('two') });

    now = 200;
    expect(store.sweep()).toBe(2);
    expect(store.size()).toBe(0);
    store.dispose();
  });

  it('gives the same answer to another user, another workspace, and a bad id', () => {
    const store = new DraftStore();
    const { id } = store.create({ ...OWNER, document: doc('secret') });

    expect(store.get(id, { workspaceId: 'T1', userId: 'U2' })).toBeNull();
    expect(store.get(id, { workspaceId: 'T2', userId: 'U1' })).toBeNull();
    expect(store.get('not-a-draft', OWNER)).toBeNull();
    // And the owner's draft is untouched by the failed attempts.
    expect(store.get(id, OWNER)).not.toBeNull();
    store.dispose();
  });

  it('refuses to delete a draft that is not yours', () => {
    const store = new DraftStore();
    const { id } = store.create({ ...OWNER, document: doc('secret') });

    expect(store.delete(id, { workspaceId: 'T1', userId: 'U2' })).toBe(false);
    expect(store.size()).toBe(1);
    expect(store.delete(id, OWNER)).toBe(true);
    expect(store.size()).toBe(0);
    store.dispose();
  });

  it('serves a draft asset by any spelling of its path, to its owner only', () => {
    const store = new DraftStore();
    const image = asset('assets/abc.png', 8);
    const { id } = store.create({ ...OWNER, document: doc('![x](assets/abc.png)', [image]) });

    expect(store.getAsset(id, OWNER, 'assets/abc.png')?.bytes.length).toBe(8);
    expect(store.getAsset(id, OWNER, './assets/abc.png')).not.toBeNull();
    expect(store.getAsset(id, OWNER, '/assets/abc.png')).not.toBeNull();
    expect(store.getAsset(id, OWNER, 'assets/other.png')).toBeNull();
    expect(store.getAsset(id, { workspaceId: 'T1', userId: 'U2' }, 'assets/abc.png')).toBeNull();
    store.dispose();
  });

  it('drops the owner’s oldest draft once they hold the maximum', () => {
    let now = 0;
    const store = new DraftStore({ maxPerUser: 2, now: () => now++ });
    const first = store.create({ ...OWNER, document: doc('one') });
    const second = store.create({ ...OWNER, document: doc('two') });
    const third = store.create({ ...OWNER, document: doc('three') });

    expect(store.get(first.id, OWNER)).toBeNull();
    expect(store.get(second.id, OWNER)).not.toBeNull();
    expect(store.get(third.id, OWNER)).not.toBeNull();
    store.dispose();
  });

  it('counts the per-user limit per person, not per process', () => {
    let now = 0;
    const store = new DraftStore({ maxPerUser: 1, now: () => now++ });
    const mine = store.create({ ...OWNER, document: doc('mine') });
    const theirs = store.create({ workspaceId: 'T1', userId: 'U2', document: doc('theirs') });

    expect(store.get(mine.id, OWNER)).not.toBeNull();
    expect(store.get(theirs.id, { workspaceId: 'T1', userId: 'U2' })).not.toBeNull();
    store.dispose();
  });

  it('evicts the oldest drafts of anyone when memory would overflow', () => {
    let now = 0;
    const store = new DraftStore({ maxTotalBytes: 250, maxPerUser: 10, now: () => now++ });
    const first = store.create({ ...OWNER, document: doc('a', [asset('assets/a.png', 100)]) });
    const second = store.create({ workspaceId: 'T2', userId: 'U9', document: doc('b', [asset('assets/b.png', 100)]) });
    const third = store.create({ ...OWNER, document: doc('c', [asset('assets/c.png', 100)]) });

    expect(store.get(first.id, OWNER)).toBeNull();
    expect(store.get(second.id, { workspaceId: 'T2', userId: 'U9' })).not.toBeNull();
    expect(store.get(third.id, OWNER)).not.toBeNull();
    expect(store.totalBytes()).toBeLessThanOrEqual(250);
    store.dispose();
  });

  it('refuses a single document larger than the whole ceiling', () => {
    const store = new DraftStore({ maxTotalBytes: 100 });
    const kept = store.create({ ...OWNER, document: doc('small') });

    let refusal: ImportRefusal | null = null;
    try {
      store.create({ ...OWNER, document: doc('x', [asset('assets/big.png', 500)]) });
    } catch (error) {
      refusal = error as ImportRefusal;
    }

    expect(refusal).toBeInstanceOf(ImportRefusal);
    expect([refusal?.status, refusal?.code]).toEqual([413, 'import_too_large']);
    // Nothing was evicted to make room for a draft that could never fit.
    expect(store.get(kept.id, OWNER)).not.toBeNull();
    store.dispose();
  });

  it('issues unguessable ids', () => {
    const store = new DraftStore({ maxPerUser: 100 });
    const ids = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      ids.add(store.create({ ...OWNER, document: doc('body') }).id);
    }

    expect(ids.size).toBe(20);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
    store.dispose();
  });
});
