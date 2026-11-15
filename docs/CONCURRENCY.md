# Concurrency & Race-Safe Membership Engine (`docs/CONCURRENCY.md`)

## The Problem: Check-Then-Act Race Conditions

Naive team-joining implementations read `member_count`, verify `member_count < max_capacity` in application memory, and then insert into `team_members`. Under 50 concurrent requests for 1 remaining seat, all 50 requests read `member_count = 1` simultaneously and insert 50 rows, breaking team capacity.

## The Solution: 12-Step Transactional `SELECT ... FOR UPDATE`

Implemented in `src/server/services/membership.ts` (`acceptJoinRequestInTx` and `directJoinTeamInTx`):

1. `BEGIN` transaction.
2. `SELECT * FROM teams WHERE id = $1 FOR UPDATE` — acquires an exclusive row-level lock on the team row.
3. Verify the team exists and is not `locked`.
4. Verify `team.member_count < team.max_capacity`.
5. Verify the user is not already in another team in the same hackathon (`team_members` check + independent DB `UNIQUE (hackathon_id, user_id)` constraint).
6. Lock and verify the pending `join_requests` row (or `invite_codes` row).
7. `INSERT INTO team_members`.
8. `UPDATE teams SET member_count = member_count + 1` (independently guarded by `CHECK (member_count <= max_capacity)`).
9. Update `join_requests` status to `accepted` and withdraw competing pending requests by that user in the same hackathon.
10. `INSERT INTO audit_logs`.
11. `SELECT pg_notify('crewforge_events', ...)` inside the transaction.
12. `COMMIT` (or `ROLLBACK` on any error).

## Idempotency Under Simultaneous Retries

`executeIdempotent` (`src/server/services/idempotency.ts`) acquires `pg_advisory_xact_lock(hashtext(scopeKey), hashtext(idempotencyKey))` at transaction start so 50+ simultaneous first-flight retries serialize cleanly until the first transaction commits, then deterministically replay the cached response (`X-Idempotent-Replay: true`) or reject payload mismatches (`409 IDEMPOTENCY_PAYLOAD_MISMATCH`).

## Verification

- **Automated Jest Suite (`tests/integration/crewforge.test.ts`)**: Runs against native PostgreSQL 16 (`pg.Pool`) across 30 scenarios, including:
  - Test #23: `50` simultaneous HTTP `POST /api/teams/:id/join` requests for `1` remaining seat (`1` × `200 OK`, `49` × `409 TEAM_AT_CAPACITY`, `0` × `5xx`).
  - Test #29: `100` simultaneous HTTP `POST /api/teams/:id/join` requests for `5` open seats (`5` × `200 OK`, `95` × `409 TEAM_AT_CAPACITY`, `0` × `5xx`).
  - Tests #24 & #30: `50` simultaneous HTTP retries sharing an `Idempotency-Key` (`1` mutation + `49` `X-Idempotent-Replay: true`).
  - Test #25: `10` simultaneous duplicate join requests (`1` created, `9` × `409 DUPLICATE_REQUEST`).
- **Live RaceLab UI (`/racelab`)**: Executes 50 real concurrent browser `fetch()` requests against an isolated sandbox team and runs live post-experiment PostgreSQL invariant verification queries.
