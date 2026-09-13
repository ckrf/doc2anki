# Shared DigitalOcean deployment

This is the recommended production shape for a small invited group:

`visitor -> Cloudflare Access -> Cloudflare Tunnel -> 127.0.0.1:3000 -> OpenAI`

The app is never exposed directly on the Droplet. Cloudflare handles HTTPS and
email sign-in, while the application verifies the authenticated email again on
the generation endpoint.

## Inputs to collect

- A stable hostname such as `laxu.example.com`.
- A Cloudflare account and the email addresses that may sign in.
- A dedicated OpenAI project service-account key for MyLaxu.
- The Droplet IP, Ubuntu version, RAM, and SSH username.
- An administrator email for DigitalOcean and OpenAI usage alerts.

Do not put passwords, SSH private keys, Cloudflare global keys, or the OpenAI
key in Git, issues, or chat transcripts. A dashboard-managed Cloudflare Tunnel
does not require sharing a Cloudflare API key with the application.

## Domain registered at Squarespace

The registration can stay at Squarespace. For Cloudflare's Free or Pro setup,
add the existing domain to Cloudflare, carefully confirm that its current web
and email DNS records were imported, and then replace the authoritative
nameservers in Squarespace with the two nameservers Cloudflare assigns.

If DNSSEC is enabled, disable it before the nameserver change and re-enable it
through Cloudflare after the zone becomes active. Do not change nameservers
until the existing Squarespace and mail records are present in Cloudflare.

Keeping authoritative DNS at Squarespace is also possible, but then this
Tunnel/Access design is not available on Cloudflare's ordinary plans. That
alternative needs public ports, a local HTTPS proxy, and a separate login
mechanism.

## Server preparation

Use an Ubuntu Droplet with at least 1 GB RAM; 2 GB is preferred. Install a
supported Node.js 22 release and Git. Create an unprivileged `laxu-focus` user,
and place a clean checkout at `/srv/laxu-focus` owned by that user.

Install dependencies and validate the release from the checkout:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

Copy `laxu-focus.env.example` to `/etc/laxu-focus.env`, replace its placeholders,
make it readable only by root, and install `laxu-focus.service` as a system
service. The service deliberately binds only to `127.0.0.1:3000`.

```sh
sudo install -m 600 ops/server/laxu-focus.env.example /etc/laxu-focus.env
sudo install -m 644 ops/server/laxu-focus.service /etc/systemd/system/laxu-focus.service
sudo systemctl daemon-reload
sudo systemctl enable --now laxu-focus.service
curl --fail http://127.0.0.1:3000/api/health
```

## Tunnel and sign-in

In Cloudflare's dashboard:

1. Create a remotely managed Tunnel and install the displayed `cloudflared`
   service command on the Droplet.
2. Add a published application hostname such as `laxu.example.com`, with the
   service URL `http://localhost:3000`.
3. Turn on **Protect with Access** for that hostname.
4. Add the one-time PIN identity provider and an Allow policy containing the
   invited email addresses. Set the policy to deny everyone else.
5. Put the same normalized comma-separated addresses in
   `LAXU_ALLOWED_EMAILS` and restart MyLaxu.

Use a DigitalOcean Cloud Firewall that permits SSH only from the administrator's
trusted IP address. Do not open ports 3000, 80, or 443 for the Tunnel design.

## Verification before invitations

Check all of the following:

- An unlisted address cannot pass the Cloudflare login page.
- An allowlisted address can open the app and generate cards.
- A 25 MB PDF receives a clear success or size error rather than a proxy page.
- Three simultaneous generations result in two active jobs and one waiting job.
- Links to `localhost`, private IPs, router addresses, and cloud metadata are
  rejected.
- `/api/health` responds locally and the service restarts after a forced stop.
- The OpenAI key never appears in browser developer tools or downloaded files.

The in-process hourly limiter resets when the app service restarts. It is a
guardrail for a small trusted group, not an accounting system. Use a separate
OpenAI project and project-level spend controls as the financial boundary.
