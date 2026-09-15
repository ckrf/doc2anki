# Doc2Anki

Doc2Anki turns uploaded or linked study material into editable flashcard
candidates. Users can review cards with the answer hidden, edit or discard
them, request more cards from the same source, and export the selected cards to
Anki.

## Requirements

- Node.js 22.13 or newer
- pnpm (via Corepack is fine)
- An OpenAI API key

## Run locally

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Set `OPENAI_API_KEY` in `.env.local`, then open `http://localhost:3000`.
Environment files are ignored by Git; never commit real keys.

## Quality checks

```sh
pnpm test
pnpm lint
pnpm build
```

The test suite covers the flashcard workflow, upload and generation API
boundaries, request safety controls, health checks, and public-URL handling.

## Project map

- `app/` — interface and API routes
- `lib/` — model catalogue, request guards, and URL/access helpers
- `tests/` — Vitest tests
- `ops/server/` — DigitalOcean, systemd, Cloudflare Tunnel, and Access guide
- `.env.example` — documented configuration without credentials

The production deployment guide is in
[`ops/server/README.md`](ops/server/README.md). The current small-group design is
Cloudflare Access → Cloudflare Tunnel → a loopback-only service on the Droplet.

## Moving to another machine or agent

Clone the repository, create `.env.local` from `.env.example`, supply a fresh
OpenAI key, install dependencies, and run the quality checks above. Production
credentials, SSH private keys, and Cloudflare tunnel credentials are
intentionally not stored in this repository and must be restored separately
from their service dashboards or a password manager.
