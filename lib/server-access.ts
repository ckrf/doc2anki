export type AccessDecision =
  | { allowed: true; actor: string }
  | { allowed: false; status: 401 | 403; message: string };

type AccessEnvironment = {
  LAXU_AUTH_REQUIRED?: string;
  LAXU_ALLOWED_EMAILS?: string;
};

const AUTHENTICATED_EMAIL_HEADERS = [
  'cf-access-authenticated-user-email',
  'oai-authenticated-user-email',
] as const;

function enabled(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(value?.trim() || '');
}

function normalizedEmails(value: string | undefined) {
  return new Set(
    (value || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

function authenticatedEmail(request: Request) {
  for (const header of AUTHENTICATED_EMAIL_HEADERS) {
    const value = request.headers.get(header)?.trim().toLowerCase();
    if (value) return value;
  }
  return '';
}

export function authorizeGenerationRequest(
  request: Request,
  environment: AccessEnvironment = process.env,
): AccessDecision {
  const email = authenticatedEmail(request);
  const authRequired = enabled(environment.LAXU_AUTH_REQUIRED);

  if (!authRequired && !email) {
    return { allowed: true, actor: 'local-development' };
  }

  if (!email) {
    return {
      allowed: false,
      status: 401,
      message: 'Sign in through the MyLaxu access page before generating cards.',
    };
  }

  const allowedEmails = normalizedEmails(environment.LAXU_ALLOWED_EMAILS);
  if (allowedEmails.size > 0 && !allowedEmails.has(email)) {
    return {
      allowed: false,
      status: 403,
      message: 'This account is not on the MyLaxu access list.',
    };
  }

  return { allowed: true, actor: email };
}
