// @vitest-environment node

import { describe, expect, test } from 'vitest';

import { GET } from '../app/api/health/route';

describe('GET /api/health', () => {
  test('reports a cache-free healthy response without exposing secrets', async () => {
    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(payload).toEqual({ status: 'ok' });
  });
});
