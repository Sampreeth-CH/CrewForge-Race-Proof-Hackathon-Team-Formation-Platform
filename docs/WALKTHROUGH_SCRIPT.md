# CrewForge — Five-Minute Walkthrough Video Script (Hack4Hack 2026, PS1)

**Total Runtime**: ~5:00  
**Presenter Setup**: Browser open to CrewForge landing page (`/`), plus a terminal ready to show `npm test` / `k6` output.

---

### [0:00 – 0:45] Problem Statement & Architectural Overview
- **On Screen**: Landing page (`/`), highlighting live participant/team telemetry (`10,008` participants, `2,004` teams) and the architectural pipeline.
- **Narration**:
  > "Hi, this is CrewForge — our solution to Hack4Hack Problem Statement 1: Race-proof hackathon team formation at scale.
  > Most hackathon platforms check `member_count < max_capacity` in application memory before inserting a member. When 50 participants click 'Join' on the last open seat simultaneously, all 50 read the same stale count and overfill the team.
  > CrewForge eliminates that race condition at the PostgreSQL layer using ACID transactions, `SELECT ... FOR UPDATE` row-level locking, database-level unique constraints, advisory-locked idempotency keys, and commit-bound `LISTEN/NOTIFY` Server-Sent Events."

---

### [0:45 – 1:45] End-to-End Team Lifecycle & Deterministic Matching
- **On Screen**:
  1. Sign in / Register (`/login` or `/register`) — note `HttpOnly` cookie session and zero password-hash exposure.
  2. Open **Team Discovery Board** (`/teams`) — filter by `Open seats`, skill, and hackathon across `2,000+` seeded teams (powered by partial covering indexes `idx_teams_open_seats_created`, `0.430 ms` execution in PostgreSQL 16 `EXPLAIN ANALYZE`).
  3. Create a team (`Create Team` modal) and inspect **Team Detail** (`/teams/:id`).
  4. Show a second user submitting a **Join Request**, the leader **Approving** it, generating a **256-bit cryptographic invite** (stored only as a SHA-256 hash), **Transferring Leadership**, and **Deterministic Teammate Recommendations** (`70%` missing/complementary skill coverage + `30%` IANA timezone compatibility).
- **Narration**:
  > "Notice that every mutation carries an `Idempotency-Key` header. If a client retries 50 times concurrently on a flaky network, `pg_advisory_xact_lock` serializes the first-flight requests and replays the exact same response (`X-Idempotent-Replay: true`) without creating duplicate teams or memberships. Meanwhile, `UNIQUE (hackathon_id, user_id)` guarantees at the schema level that no participant can ever join two teams in the same hackathon."

---

### [1:45 – 3:05] Live RaceLab: 50 Concurrent Requests for 1 Seat
- **On Screen**: Navigate to **RaceLab** (`/racelab`), select the isolated sandbox target team (`1` open seat, `50` competing users), and click **Launch Concurrency Experiment**.
- **Narration**:
  > "Here in RaceLab, we prove our concurrency guarantees live against real HTTP requests and real database transactions. Clicking Launch provisions 50 synthetic authenticated competitor JWTs and fires 50 simultaneous `POST /api/teams/:id/join` `fetch()` calls via `Promise.all` for a single open seat.
  > Watch the 50-cell matrix resolve: exactly **1** competitor turns green (`200 OK — WON`), **49** are cleanly rejected (`409 TEAM_AT_CAPACITY`), and **0** `5xx` server errors occur. Below, the live post-run PostgreSQL consistency verifier confirms `member_count (2) == COUNT(*) (2)`, zero duplicate hackathon memberships, and persisted audit events."

---

### [3:05 – 3:55] Immutable Audit Explorer & Commit-Bound Real-Time SSE
- **On Screen**:
  1. Open **Audit Explorer** (`/audit`) showing `TEAM_CREATED`, `JOIN_REQUEST_ACCEPTED`, `LEADER_TRANSFERRED`, `RACE_LAB_RUN`, and `MEMBERSHIP_CREATED`.
  2. Point out the live `SSE Connected` status indicator in the navbar (`EventSource` on `/api/events/stream`).
- **Narration**:
  > "Audit logs live in a table with no cascading foreign key on `team_id`, so even if a team is disbanded when its last member leaves, the complete history survives.
  > Real-time updates never leak uncommitted state: every mutation runs `SELECT pg_notify('crewforge_events', ...)` inside the transaction. If an operation rolls back—such as the 49 rejected join attempts—PostgreSQL suppresses the notification completely."

---

### [3:55 – 4:45] Native PostgreSQL 16 Suite & `k6` Load Benchmarks
- **On Screen**: Switch to terminal showing `npm test` (`21/21` blocks, `30` scenarios on native PostgreSQL 16) and `k6 run tests/load/k6-teams.js`.
- **Narration**:
  > "Against native PostgreSQL 16 with `pg.Pool` (`max = 30`), our full integration suite passes all 30 scenarios—including 50 users for 1 seat, 100 users for 5 seats (`5` winners, `95` `409`s), and 50 simultaneous `Idempotency-Key` retries (`1` mutation, `49` replays).
  > Under `k6` at 100 concurrent virtual users across pages 1–5 of team discovery (`8,362` requests at `551.38 req/s`), CrewForge achieved `78.64 ms` average latency, **`116.00 ms` p95**—well below the `200 ms` threshold—and **`0.00%` error rate**."

---

### [4:45 – 5:00] Closing & Deployment Readiness
- **On Screen**: Show `docker-compose.yml`, `Dockerfile`, `.github/workflows/ci.yml`, and `DESIGN.md`.
- **Narration**:
  > "CrewForge ships ready for Cloud Run, Docker Compose, or any hosted PostgreSQL 16 provider via `DATABASE_URL` with SSL. Thank you!"
