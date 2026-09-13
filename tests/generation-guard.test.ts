// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';

import {
  FixedWindowRateLimiter,
  GenerationQueue,
  GenerationQueueFullError,
} from '../lib/generation-guard';

describe('generation rate limiter', () => {
  test('limits each caller independently and resets after the window', () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000);

    expect(limiter.take('a', 0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.take('a', 10)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.take('a', 20)).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.take('b', 20)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.take('a', 1_001)).toMatchObject({ allowed: true, remaining: 1 });
  });
});

describe('generation queue', () => {
  test('caps active and waiting generations and releases the next caller', async () => {
    const queue = new GenerationQueue(1, 1);
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstOperation = vi.fn(async () => { await firstGate; return 'first'; });
    const secondOperation = vi.fn(async () => 'second');

    const first = queue.run(firstOperation);
    await Promise.resolve();
    const second = queue.run(secondOperation);
    await Promise.resolve();
    const third = queue.run(async () => 'third');

    await expect(third).rejects.toBeInstanceOf(GenerationQueueFullError);
    expect(secondOperation).not.toHaveBeenCalled();
    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });
});
