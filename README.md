# CrewForge — Race-Proof Hackathon Team Formation Platform

CrewForge is a full-stack hackathon team formation platform engineered for **Hack4Hack Crew Hiring Challenge 2026 (PS1 — Race-proof team formation at scale)**.

It enforces capacity limits, one-team-per-user-per-hackathon uniqueness, idempotent mutations, cryptographic invitations, and commit-bound real-time updates inside ACID PostgreSQL transactions.

## Core Architecture

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, React Router, Axios, TanStack Query.
- **Backend**: Node.js, Express.js, TypeScript, Zod validation, Server-Sent Events (SSE).
- **Database**: PostgreSQL (`pg` connection pool for Cloud SQL / external PostgreSQL; `@electric-sql/pglite` embedded PostgreSQL fallback when no external PostgreSQL host is configured), SQL migrations (`/migrations/001_init.sql`), parameterized SQL queries.
- **Testing**: `node:test` pure logic unit tests, Jest + Supertest 28-scenario PostgreSQL integration & 50-user concurrency test, k6 load script & Node concurrency benchmark.
- **Deployment**: Google Cloud Run (`Dockerfile`), GitHub Actions CI (`.github/workflows/ci.yml`), Firebase Auth & hardened Firestore rules (`firestore.rules`).

## Quick Start

### Option A: Native PostgreSQL 16 via Docker Compose (Recommended)
```bash
docker compose up -d postgres
export SQL_HOST=127.0.0.1 SQL_PORT=5432 SQL_USER=crewforge SQL_PASSWORD=crewforge_local_dev_pw SQL_DATABASE=crewforge
npm install
npm run migrate
npm run seed          # Seeds 10,000 users and 2,000 teams idempotently
npm run dev           # Starts Express + Vite on http://localhost:3000
```

### Option B: Free Hosted PostgreSQL (Neon, Supabase, or Render)
If Docker is unavailable, create a free PostgreSQL 16 database (e.g., on `neon.tech` or `supabase.com`) and export:
```bash
export DATABASE_URL="postgresql://<user>:<password>@<host>/<db>?sslmode=require"
npm install && npm run migrate && npm run seed && npm start
```

### Required Environment Variables
See [`.env.example`](.env.example): `SQL_HOST`, `SQL_PORT`, `SQL_USER`, `SQL_PASSWORD`, `SQL_DATABASE`, `SQL_SSL` (or `DATABASE_URL`), `PG_POOL_MAX`, `JWT_SECRET` (required in production, ≥16 chars), `CORS_ORIGIN`, `APP_URL`, `VITE_API_URL` (for split frontend/backend origins), `PORT`.

## Verification & Testing

```bash
npm run lint          # TypeScript typecheck
npm run test:unit     # Fast pure-logic unit tests (node:test)
npm test              # Integration scenarios + 50/100-user concurrency & idempotency tests
npm run build         # Production Vite bundle
```

## Documentation

- [`DESIGN.md`](DESIGN.md) — One-page architecture & engineering trade-offs
- [`docs/DATABASE.md`](docs/DATABASE.md) — Schema, constraints, indexing, Docker Compose & hosted PostgreSQL setup
- [`docs/CONCURRENCY.md`](docs/CONCURRENCY.md) — `SELECT ... FOR UPDATE` and RaceLab verification
- [`docs/SECURITY.md`](docs/SECURITY.md) — Auth, HTTP-only cookies, 256-bit invites, RBAC
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) — Verified load-test results on 2,000 teams / 10,000 users
- [`docs/API.md`](docs/API.md) — REST endpoints, idempotency headers, and SSE event schema
- [`docs/WALKTHROUGH_SCRIPT.md`](docs/WALKTHROUGH_SCRIPT.md) — Five-minute competition walkthrough script
