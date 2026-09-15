import { NextResponse } from 'next/server';

import { getAccessPolicy, policyEmails, setAccessPolicyEmails } from '../../../../lib/cloudflare-access';
import { authorizeAdminRequest } from '../../../../lib/server-access';

function validEmail(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function adminError(request: Request) {
  const access = authorizeAdminRequest(request);
  return access.allowed ? null : NextResponse.json({ error: access.message }, { status: access.status });
}

export async function GET(request: Request) {
  const denied = adminError(request);
  if (denied) return denied;
  try {
    const policy = await getAccessPolicy();
    return NextResponse.json({ emails: policyEmails(policy) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load friends.' }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const denied = adminError(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as { email?: unknown } | null;
  if (!validEmail(body?.email)) return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });

  try {
    const policy = await getAccessPolicy();
    const emails = [...policyEmails(policy), body.email];
    const updated = await setAccessPolicyEmails(emails);
    return NextResponse.json({ emails: policyEmails(updated) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not add that friend.' }, { status: 502 });
  }
}

export async function DELETE(request: Request) {
  const access = authorizeAdminRequest(request);
  if (!access.allowed) return NextResponse.json({ error: access.message }, { status: access.status });
  const body = await request.json().catch(() => null) as { email?: unknown } | null;
  if (!validEmail(body?.email)) return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });

  const admins = new Set((process.env.DOC2ANKI_ADMIN_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
  if (admins.has(body.email.trim().toLowerCase())) {
    return NextResponse.json({ error: 'Administrator addresses cannot be removed here.' }, { status: 400 });
  }

  try {
    const policy = await getAccessPolicy();
    const emails = policyEmails(policy).filter((email) => email !== body.email!.trim().toLowerCase());
    const updated = await setAccessPolicyEmails(emails);
    return NextResponse.json({ emails: policyEmails(updated) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not remove that friend.' }, { status: 502 });
  }
}
