// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';

import { getAccessPolicy, policyEmails, setAccessPolicyEmails } from '../lib/cloudflare-access';

const environment = {
  CLOUDFLARE_ACCOUNT_ID: 'account-id',
  CLOUDFLARE_ACCESS_POLICY_ID: 'policy-id',
  CLOUDFLARE_API_TOKEN: 'secret-token',
};

function response(result: object) {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Cloudflare Access friend management', () => {
  test('reads and normalizes exact-email rules', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      include: [{ email: { email: 'Friend@Example.com' } }, { email: { email: 'admin@example.com' } }],
    }));
    expect(policyEmails(await getAccessPolicy(environment, fetcher))).toEqual([
      'admin@example.com',
      'friend@example.com',
    ]);
  });

  test('updates email rules while preserving other policy rules', async () => {
    const existing = {
      name: 'Allowed Doc2Anki users',
      decision: 'allow',
      session_duration: '24h',
      include: [{ email: { email: 'old@example.com' } }, { geo: { country_code: 'US' } }],
      exclude: [{ email: { email: 'blocked@example.com' } }],
      require: [{ auth_method: { auth_method: 'mfa' } }],
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(existing))
      .mockResolvedValueOnce(response({ ...existing, include: [{ geo: { country_code: 'US' } }, { email: { email: 'new@example.com' } }] }));

    await setAccessPolicyEmails(['NEW@example.com', 'new@example.com'], environment, fetcher);
    const request = fetcher.mock.calls[1][1] as RequestInit;
    expect(request.method).toBe('PUT');
    expect(JSON.parse(String(request.body))).toEqual({
      name: 'Allowed Doc2Anki users',
      decision: 'allow',
      include: [{ geo: { country_code: 'US' } }, { email: { email: 'new@example.com' } }],
      exclude: existing.exclude,
      require: existing.require,
      session_duration: '24h',
    });
  });

  test('fails closed when credentials are absent', async () => {
    await expect(getAccessPolicy({}, vi.fn())).rejects.toThrow('not configured');
  });
});
