import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDocState, mutateDocState } from 'services/google/gdocs-state';
import { retireAllReviewCards, retireReviewCards } from 'services/google/review-cards';

const cards = [
  { managerId: 'U-a', channel: 'D-a', ts: '1.0' },
  { managerId: 'U-b', channel: 'D-b', ts: '2.0' },
];

describe('retiring review cards', () => {
  let tempDir: string;
  let update: jest.Mock;
  let client: { chat: { update: jest.Mock } };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-gdocs-cards-'));
    process.env.CHOIR_DATA_DIR = tempDir;
    update = jest.fn().mockResolvedValue({});
    client = { chat: { update } };

    await mutateDocState('T1', 'docs/a.md', () => ({
      status: 'pending-review',
      reviewCards: cards,
      updatedAt: '',
    }));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
  });

  it('replaces every card so the buttons disappear', async () => {
    await retireReviewCards({
      workspaceId: 'T1',
      githubPath: 'docs/a.md',
      notice: { reason: 'gdocs.card.retired.unlinkedReview' },
      client: client as never,
    });

    expect(update).toHaveBeenCalledTimes(2);
    // Only a section block is sent, which is what removes the actions.
    expect(update.mock.calls[0][0].blocks).toHaveLength(1);
    expect((await getDocState('T1', 'docs/a.md'))?.reviewCards).toBeUndefined();
  });

  it('clears the refs even when Slack cannot be reached', async () => {
    update.mockRejectedValue(new Error('channel_not_found'));

    await retireReviewCards({
      workspaceId: 'T1',
      githubPath: 'docs/a.md',
      notice: { reason: 'gdocs.card.retired.unlinkedReview' },
      client: client as never,
    });

    // The buttons are dead regardless; a later drift should post fresh cards
    // rather than try to update messages describing a mapping that is gone.
    expect((await getDocState('T1', 'docs/a.md'))?.reviewCards).toBeUndefined();
  });

  it('does nothing for a document with no cards', async () => {
    await retireReviewCards({
      workspaceId: 'T1',
      githubPath: 'docs/none.md',
      notice: { reason: 'gdocs.card.retired.unlinkedReview' },
      client: client as never,
    });

    expect(update).not.toHaveBeenCalled();
  });

  it('retires every document in the workspace on disconnect', async () => {
    await mutateDocState('T1', 'docs/b.md', () => ({ status: 'drifted', reviewCards: cards, updatedAt: '' }));

    await retireAllReviewCards({
      workspaceId: 'T1',
      notice: { reason: 'gdocs.card.retired.disconnectedReview' },
      client: client as never,
    });

    expect(update).toHaveBeenCalledTimes(4);
    expect((await getDocState('T1', 'docs/b.md'))?.reviewCards).toBeUndefined();
  });

  it('still clears state when no Slack client is available', async () => {
    await retireReviewCards({
      workspaceId: 'T1',
      githubPath: 'docs/a.md',
      notice: { reason: 'gdocs.card.retired.unlinkedReview' },
    });

    expect((await getDocState('T1', 'docs/a.md'))?.reviewCards).toBeUndefined();
  });
});
