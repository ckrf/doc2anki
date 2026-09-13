type RateLimitBucket = {
  count: number;
  startedAt: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  take(key: string, now = Date.now()): RateLimitDecision {
    const current = this.buckets.get(key);
    const expired = !current || now - current.startedAt >= this.windowMs;
    const bucket = expired ? { count: 0, startedAt: now } : current;

    if (bucket.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.startedAt + this.windowMs - now) / 1_000)),
      };
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - bucket.count),
      retryAfterSeconds: 0,
    };
  }
}

export class GenerationQueueFullError extends Error {
  constructor() {
    super('The generation queue is full.');
    this.name = 'GenerationQueueFullError';
  }
}

export class GenerationQueue {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {}

  private acquire() {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueued) {
      throw new GenerationQueueFullError();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }

  async run<T>(operation: () => Promise<T>) {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }
}

export function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
