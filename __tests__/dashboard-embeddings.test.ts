import { cosineSimilarity, meanVector } from 'services/dashboard/embeddings';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  it('is 0 when either vector is all zeros (no NaN)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it('works on Float32Array inputs', () => {
    expect(cosineSimilarity(Float32Array.from([1, 1]), Float32Array.from([1, 1]))).toBeCloseTo(1, 6);
  });
});

describe('meanVector', () => {
  it('averages element-wise', () => {
    const m = meanVector([Float32Array.from([1, 3]), Float32Array.from([3, 1])]);
    expect(Array.from(m)).toEqual([2, 2]);
  });
});
