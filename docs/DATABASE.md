# Database Architecture (`docs/DATABASE.md`)

## Schema Overview

Defined in `/migrations/001_init.sql`:

| Table | Purpose | Key Constraints & Indexes |
| --- | --- | --- |
| `users` | Participant, organizer, and admin accounts | `UNIQUE (email)`, `UNIQUE (firebase_uid)`, `GIN (skills)`, `CHECK (experience_level)` |
| `hackathons` | Multi-hackathon configuration | `UNIQUE (slug)`, `CHECK (max_team_size >= min_team_size)` |
| `teams` | Hackathon teams with denormalized count | `UNIQUE (hackathon_id, name)`, `CHECK (member_count <= max_capacity)`, `idx_teams_discovery`, `GIN (required_skills)` |
| `team_members` | Membership ledger | `UNIQUE (hackathon_id, user_id)` (1 team per user per hackathon), `UNIQUE (team_id, user_id)`, `idx_team_members_team_joined` |
| `join_requests` | Pending/reviewed join applications | Partial unique index `idx_join_requests_pending_unique` on `(team_id, user_id) WHERE status = 'pending'` |
| `invite_codes` | Hashed cryptographic team invites | `UNIQUE (code_hash)` (SHA-256 only), `CHECK (uses_count <= max_uses)` |
| `idempotency_keys` | Request deduplication ledger | `UNIQUE (scope_key, idempotency_key)` |
| `audit_logs` | Immutable mutation history | No FK cascade on `team_id` so audit trail persists post-deletion; indexed on `(team_id, created_at DESC)` and `(action, created_at DESC)` |

## Connection Modes & Environment Variables

`src/server/db/client.ts` supports two PostgreSQL execution backends:
1. **Native PostgreSQL (`pg.Pool`)**: Activated automatically when `SQL_HOST`, `PGHOST`, or `DATABASE_URL` is set (`PG_POOL_MAX` defaults to `30`).
   - **Host/Credentials Variables**: `SQL_HOST`, `SQL_PORT` (default `5432`), `SQL_USER`, `SQL_PASSWORD`, `SQL_DATABASE` (or `SQL_DB_NAME`), `SQL_SSL` (`true` for TLS), `PG_POOL_MAX` (`30`). Standard `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` are also supported.
   - **Connection String**: `DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/crewforge?sslmode=require"` (automatically enables SSL when `sslmode=require` or `SQL_SSL=true`).
2. **Embedded PostgreSQL (`@electric-sql/pglite`)**: Local fallback used only when no external PostgreSQL host/URL is configured.

## Running Native PostgreSQL Locally

### Option 1: Docker Compose (Recommended)
```bash
docker compose up -d postgres
SQL_HOST=127.0.0.1 SQL_PORT=5432 SQL_USER=crewforge SQL_PASSWORD=crewforge_local_dev_pw SQL_DATABASE=crewforge npm run migrate
```

### Option 2: Free Hosted PostgreSQL (Neon, Supabase, or Render)
If Docker is unavailable, provision a free-tier PostgreSQL 16 database on Neon (`neon.tech`) or Supabase, copy its connection string, and set:
```bash
DATABASE_URL="postgresql://<user>:<password>@<host>/<db>?sslmode=require"
```
Then run `npm run migrate && npm run seed && npm start`.
