# CrewForge — One-Page System Design Document

## 1. Database Design

CrewForge models eight core tables in PostgreSQL (`/migrations/001_init.sql`): `users`, `hackathons`, `teams`, `team_members`, `join_requests`, `invite_codes`, `idempotency_keys`, and `audit_logs`.

- **Invariant Enforcement**: `team_members` carries `UNIQUE (hackathon_id, user_id)`, independently preventing any participant from joining two teams in the same hackathon regardless of application logic.
- **Capacity Safety**: `teams` maintains a denormalized `member_count` alongside `CHECK (member_count >= 0 AND member_count <= max_capacity)` so discovery queries avoid expensive `COUNT(*)` joins while remaining mathematically bounded.
- **Audit Independence**: `audit_logs.team_id` has no cascading foreign key to `teams`, ensuring creation, transfer, and deletion logs survive team disbandment.

## 2. Transaction Strategy

Every state-changing membership operation (`createTeam`, `acceptJoinRequest`, `directJoinTeam`, `leaveTeam`, `removeMember`, `transferLeadership`, `deleteTeam`) runs inside a single PostgreSQL `BEGIN ... COMMIT` transaction. Any validation error, constraint violation, or runtime exception triggers an immediate `ROLLBACK`.

## 3. Concurrency Prevention

When 50 users simultaneously contend for the final seat on a team:

1. Each request opens a transaction and locks the target row via `SELECT * FROM teams WHERE id = $1 FOR UPDATE`.
2. PostgreSQL serializes competing transactions on that row lock. Only the first transaction observes `member_count < max_capacity`.
3. It inserts into `team_members`, increments `member_count`, writes `audit_logs`, emits `pg_notify`, and commits.
4. The remaining 49 transactions acquire the lock post-commit, observe `member_count === max_capacity`, roll back cleanly, and return `409 TEAM_AT_CAPACITY`.

In standalone environments without external PostgreSQL (`SQL_HOST`/`PGHOST`), `DatabaseManager` runs embedded `@electric-sql/pglite` (WASM PostgreSQL) with a serialized transaction queue around `BEGIN ... SELECT FOR UPDATE ... COMMIT` so SQL constraints and ACID semantics execute identically.

## 4. Idempotency

Mutation endpoints (`POST /api/teams`, `PATCH /api/teams/:id`, `POST /api/teams/:id/join`, `POST /api/teams/:id/join-requests`, `accept`, `reject`) honor `Idempotency-Key`. Inside the mutation transaction, CrewForge acquires `SELECT pg_advisory_xact_lock(hashtext(scope_key), hashtext(idempotency_key))`, hashes the canonicalized JSON body (SHA-256), and checks `idempotency_keys` under `UNIQUE (scope_key, idempotency_key)`:
- **Same key + same payload**: replays the original status code and JSON body with `X-Idempotent-Replay: true`.
- **Same key + different payload**: returns `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.
- **Concurrent duplicate retries**: serialized deterministically on the transaction-scoped advisory lock without creating duplicate teams or memberships.

## 5. Security

- Passwords are hashed with `bcryptjs` and never returned in API responses.
- Sessions use signed JWTs stored in `HttpOnly` cookies (`crewforge_session`; `SameSite=None; Secure` in production HTTPS, `SameSite=Lax` locally), with RBAC checks (`participant`, `organizer`, `admin`) and leader-only gates on team management routes.
- Invitation tokens generate 256 bits (`crypto.randomBytes(32)`) of entropy; only SHA-256 digests (`code_hash`) and short display prefixes are persisted.
- Rate limiting protects auth and invite redemption routes against brute-force attempts.

## 6. Real-Time Architecture

Every committed team mutation calls `SELECT pg_notify('crewforge_events', payload)` inside the active transaction. Because PostgreSQL delivers `NOTIFY` only after `COMMIT`, clients connected to `/api/events/stream` (SSE) never observe uncommitted or rolled-back updates. The React frontend invalidates TanStack Query caches automatically on incoming events.

## 7. Performance Trade-offs

- **Denormalized `member_count` + Composite Index**: `idx_teams_discovery (hackathon_id, status, member_count, max_capacity, created_at DESC)` allows paginated board queries to execute via a single index scan + leader join without `GROUP BY` aggregation over `team_members`.
- **GIN Indexes**: `idx_teams_skills_gin` and `idx_users_skills_gin` accelerate skill matching.
- **Trade-off**: Write transactions take an exclusive row lock on the target `teams` row during joins; lock hold time is sub-millisecond because no external network calls occur inside transactions.

## 8. What Would Be Improved With Another Week

1. **Keyset (Cursor) Pagination**: Replace `OFFSET` pagination on `/api/teams` and `/api/audit-logs` with `(created_at, id)` cursors for constant-time deep paging at 100k+ teams.
2. **Read Replicas & PgBouncer**: Route read-only discovery and analytics traffic to Cloud SQL read replicas while keeping transactional `SELECT FOR UPDATE` traffic on the primary via transaction-pooled PgBouncer.
3. **Outbox Worker for External Webhooks**: Mirror `audit_logs` into an asynchronous outbox relay for Slack/Discord hackathon notifications without extending database lock durations.
