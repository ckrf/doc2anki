// @vitest-environment node

import { describe, expect, test } from 'vitest';

import { authorizeGenerationRequest } from '../lib/server-access';

describe('generation access checks', () => {
  test('allows local development when external authentication is disabled', () => {
    const decision = authorizeGenerationRequest(new Request('http://localhost/api/generate'), {});
    expect(decision).toEqual({ allowed: true, actor: 'local-development' });
  });

  test('requires an authenticated email when protection is enabled', () => {
    const decision = authorizeGenerationRequest(
      new Request('https://laxu.example/api/generate'),
      { LAXU_AUTH_REQUIRED: 'true' },
    );
    expect(decision).toMatchObject({ allowed: false, status: 401 });
  });

  test('accepts allowlisted Cloudflare and Sites identities case-insensitively', () => {
    const environment = {
      LAXU_AUTH_REQUIRED: 'true',
      LAXU_ALLOWED_EMAILS: 'owner@example.com, Friend@Example.com',
    };
    const cloudflare = authorizeGenerationRequest(new Request('https://laxu.example/api/generate', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'friend@example.com' },
    }), environment);
    const sites = authorizeGenerationRequest(new Request('https://laxu.example/api/generate', {
      headers: { 'oai-authenticated-user-email': 'OWNER@EXAMPLE.COM' },
    }), environment);

    expect(cloudflare).toEqual({ allowed: true, actor: 'friend@example.com' });
    expect(sites).toEqual({ allowed: true, actor: 'owner@example.com' });
  });

  test('rejects authenticated users who are not allowlisted', () => {
    const decision = authorizeGenerationRequest(new Request('https://laxu.example/api/generate', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'stranger@example.com' },
    }), {
      LAXU_AUTH_REQUIRED: 'true',
      LAXU_ALLOWED_EMAILS: 'owner@example.com',
    });
    expect(decision).toMatchObject({ allowed: false, status: 403 });
  });
});
