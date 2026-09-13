import { resolve4, resolve6 } from 'node:dns/promises';

export type AddressResolver = (hostname: string) => Promise<string[]>;

const NON_PUBLIC_HOST_SUFFIXES = [
  '.home',
  '.internal',
  '.invalid',
  '.lan',
  '.local',
  '.localhost',
  '.onion',
  '.test',
];

function parseIpv4(value: string) {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return bytes;
}

function parseIpv6(value: string) {
  let input = value.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!input || (input.match(/::/g) || []).length > 1) return null;

  const embeddedIpv4 = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embeddedIpv4) {
    const bytes = parseIpv4(embeddedIpv4);
    if (!bytes) return null;
    const replacement = `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
    input = input.slice(0, -embeddedIpv4.length) + replacement;
  }

  const sides = input.split('::');
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides[1] ? sides[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((sides.length === 1 && missing !== 0) || (sides.length === 2 && missing < 1)) return null;

  const groups = sides.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.flatMap((group) => {
    const number = Number.parseInt(group, 16);
    return [number >> 8, number & 0xff];
  });
}

function isPublicIpv4(value: string) {
  const bytes = parseIpv4(value);
  if (!bytes) return false;
  const [a, b, c] = bytes;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(value: string) {
  const bytes = parseIpv6(value);
  if (!bytes) return false;

  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  if (allZero || loopback) return false;
  if ((bytes[0] & 0xfe) === 0xfc) return false;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false;
  if (bytes[0] === 0xff) return false;
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;

  const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0)
    && bytes[10] === 0xff
    && bytes[11] === 0xff;
  const ipv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  if (ipv4Mapped || ipv4Compatible) {
    return isPublicIpv4(bytes.slice(12).join('.'));
  }

  return true;
}

export function isPublicIpAddress(value: string) {
  const normalized = value.replace(/^\[|\]$/g, '');
  return normalized.includes(':') ? isPublicIpv6(normalized) : isPublicIpv4(normalized);
}

async function resolveAddresses(hostname: string) {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const addresses = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  if (addresses.length === 0) throw new Error('The source hostname could not be resolved.');
  return addresses;
}

export async function assertPublicHttpUrl(
  value: string | URL,
  resolver: AddressResolver = resolveAddresses,
) {
  const parsed = value instanceof URL ? new URL(value) : new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only public http and https links are supported.');
  }
  if (parsed.username || parsed.password) throw new Error('Source links cannot contain login credentials.');
  if (parsed.port && !['80', '443'].includes(parsed.port)) {
    throw new Error('Source links may use only standard web ports.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    hostname === 'localhost'
    || (!hostname.includes('.') && !hostname.includes(':'))
    || NON_PUBLIC_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error('The source link must use a public internet hostname.');
  }

  const literalIp = hostname.includes(':') || parseIpv4(hostname) ? [hostname] : [];
  const addresses = literalIp.length ? literalIp : await resolver(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new Error('The source link resolves to a private or reserved network address.');
  }
  return parsed;
}
