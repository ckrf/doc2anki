// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';

import { assertPublicHttpUrl, isPublicIpAddress } from '../lib/public-url';

describe('public linked-source validation', () => {
  test('allows ordinary public web destinations', async () => {
    const resolver = vi.fn().mockResolvedValue(['93.184.216.34']);
    const url = await assertPublicHttpUrl('https://example.com/chapter.pdf', resolver);

    expect(url.href).toBe('https://example.com/chapter.pdf');
    expect(resolver).toHaveBeenCalledWith('example.com');
  });

  test('allows a literal public IPv6 destination without DNS resolution', async () => {
    const resolver = vi.fn();
    const url = await assertPublicHttpUrl('https://[2606:4700:4700::1111]/chapter', resolver);

    expect(url.hostname).toBe('[2606:4700:4700::1111]');
    expect(resolver).not.toHaveBeenCalled();
  });

  test.each([
    'http://localhost/secret',
    'http://127.0.0.1/secret',
    'http://169.254.169.254/latest/meta-data',
    'http://192.168.1.1/router',
    'http://[::1]/secret',
    'http://[::ffff:127.0.0.1]/secret',
  ])('blocks local and private address %s', async (value) => {
    await expect(assertPublicHttpUrl(value)).rejects.toThrow(/public|private|reserved/);
  });

  test('blocks a public-looking hostname when DNS returns a private address', async () => {
    await expect(assertPublicHttpUrl(
      'https://documents.example.net/chapter',
      vi.fn().mockResolvedValue(['10.0.0.8']),
    )).rejects.toThrow('private or reserved');
  });

  test('blocks credentials and non-web ports', async () => {
    const resolver = vi.fn().mockResolvedValue(['93.184.216.34']);
    await expect(assertPublicHttpUrl('https://name:secret@example.com/file', resolver)).rejects.toThrow('credentials');
    await expect(assertPublicHttpUrl('https://example.com:8080/file', resolver)).rejects.toThrow('standard web ports');
  });

  test('classifies representative public and non-public IP addresses', () => {
    expect(isPublicIpAddress('8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIpAddress('100.64.0.1')).toBe(false);
    expect(isPublicIpAddress('fc00::1')).toBe(false);
  });
});
