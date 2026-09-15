type CloudflareEnvironment = {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ACCESS_POLICY_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
};

type AccessRule = { email?: { email?: string }; [key: string]: unknown };
type AccessPolicy = {
  name?: string;
  decision?: string;
  include?: AccessRule[];
  exclude?: AccessRule[];
  require?: AccessRule[];
  session_duration?: string;
};

type CloudflareResponse<T> = {
  success: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
};

function config(environment: CloudflareEnvironment) {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID?.trim();
  const policyId = environment.CLOUDFLARE_ACCESS_POLICY_ID?.trim();
  const token = environment.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !policyId || !token) {
    throw new Error('Friend management is not configured yet.');
  }
  return { accountId, policyId, token };
}

async function requestPolicy(
  environment: CloudflareEnvironment,
  fetcher: typeof fetch,
  init?: RequestInit,
) {
  const { accountId, policyId, token } = config(environment);
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/access/policies/${encodeURIComponent(policyId)}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    },
  );
  const payload = await response.json() as CloudflareResponse<AccessPolicy>;
  if (!response.ok || !payload.success || !payload.result) {
    throw new Error(payload.errors?.[0]?.message || 'Cloudflare could not update the access list.');
  }
  return payload.result;
}

function emailRules(policy: AccessPolicy) {
  return (policy.include ?? []).filter((rule) => rule.email?.email);
}

export function policyEmails(policy: AccessPolicy) {
  return emailRules(policy)
    .map((rule) => rule.email?.email?.trim().toLowerCase() || '')
    .filter(Boolean)
    .sort();
}

export async function getAccessPolicy(
  environment: CloudflareEnvironment = process.env,
  fetcher: typeof fetch = fetch,
) {
  return requestPolicy(environment, fetcher);
}

export async function setAccessPolicyEmails(
  emails: string[],
  environment: CloudflareEnvironment = process.env,
  fetcher: typeof fetch = fetch,
) {
  const current = await requestPolicy(environment, fetcher);
  const nonEmailRules = (current.include ?? []).filter((rule) => !rule.email?.email);
  const normalizedEmails = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))].sort();
  const body = {
    name: current.name || 'Allowed Doc2Anki users',
    decision: current.decision || 'allow',
    include: [...nonEmailRules, ...normalizedEmails.map((email) => ({ email: { email } }))],
    exclude: current.exclude ?? [],
    require: current.require ?? [],
    ...(current.session_duration ? { session_duration: current.session_duration } : {}),
  };
  return requestPolicy(environment, fetcher, { method: 'PUT', body: JSON.stringify(body) });
}
