# CrewForge Performance & Concurrency Benchmarks

All measurements below were **directly executed and measured** against a seeded dataset of **10,008 users**, **2,005 teams**, **6,007 memberships**, and **5 hackathons** (`Node.js v22.23.2`, `linux/x64`).

---

## 1. Native PostgreSQL 16 Query Plan (`EXPLAIN (ANALYZE, BUFFERS)`)

Target endpoint: `GET /api/teams?page=1&limit=20&openOnly=true` on **PostgreSQL 16.16** (`PG_POOL_MAX=30`), after applying partial covering indexes (`migrations/003_open_discovery_index.sql`):

### Count Query
- **Plan**: `Aggregate` -> `Index Only Scan using idx_teams_open_seats_hackathon on teams t`
- **Heap Fetches**: `0`
- **Shared Buffers Hit**: `5`
- **Planning Time**: `1.420 ms`
- **Measured Execution Time**: **`0.621 ms`**

### Paginated Discovery Query (`LIMIT 20`)
- **Plan**: `Limit` -> `Nested Loop` (`idx_teams_open_seats_created` -> `Memoize` on `hackathons_pkey` [17 cache hits, 3 misses] -> `Index Scan using users_pkey`)
- **Sequential Scans / Disk Sorts**: `0` / `0`
- **Shared Buffers Hit**: `70`
- **Planning Time**: `2.497 ms`
- **Measured Execution Time**: **`0.430 ms`**

### Optimizations Applied
1. Added `migrations/003_open_discovery_index.sql` (`idx_teams_open_seats_created`, `idx_teams_open_seats_hackathon`) targeting `WHERE is_demo_sandbox = FALSE AND member_count < max_capacity AND status <> 'locked'`.
2. Removed unused `optionalAuth` database lookup from `GET /api/teams`.
3. Parallelized the `COUNT(*)` and paginated `SELECT` queries via `Promise.all` over `pg.Pool` (`PG_POOL_MAX=30`).

---

## 2. 100-Virtual-User Load Tests: PGlite Baseline vs. Native PostgreSQL 16

### A. Official `k6` Multi-Page Load Test (`tests/load/k6-teams.js` on Native PostgreSQL 16)
Executed with `k6 v0.54.0` (`100` looping VUs for `15s`, rotating pages `1..5`, `limit=20`, `openOnly=true`) against `NODE_ENV=production` Express + `pg.Pool` (`PG_POOL_MAX=30`):

| Metric | Measured Value | Target | Status |
| --- | --- | --- | --- |
| Virtual Users (`vus`) | `100` | `100` | PASS |
| Total HTTP Requests | **`8,362`** | `>= 1,000` | PASS |
| Throughput (`http_reqs`) | **`551.38 req/s`** | — | — |
| Average Latency (`avg`) | **`78.64 ms`** | — | — |
| Median Latency (`p50`) | **`70.71 ms`** | — | — |
| `p95` Latency | **`116.00 ms`** | `< 200 ms` | **PASS** |
| `p99` Latency | **`272.42 ms`** | — | — |
| Error Rate (`http_req_failed`) | **`0.00%`** (`0 / 8,362`) | `< 1%` | **PASS** |
| Functional Checks | **`100.00%`** (`16,724 / 16,724`) | `100%` | **PASS** |

### B. Zero-Think-Time Burst Comparison (`scripts/benchmark.ts`: `100` simultaneous VUs × `10` waves = `1,000` requests)

| Metric | Prior PGlite WASM Baseline | Native PostgreSQL 16 (`pg.Pool`) | Delta |
| --- | --- | --- | --- |
| Total Time (`1,000` reqs) | `5,636 ms` | **`2,455 ms`** | **2.30× faster** |
| Throughput | `177.43 req/s` | **`407.33 req/s`** | **+129.6%** |
| Average Latency | `292.59 ms` | **`149.27 ms`** | **-49.0%** |
| Median (`p50`) | `291.03 ms` | **`149.01 ms`** | **-48.8%** |
| `p95` Latency | `550.65 ms` | **`254.02 ms`** | **-53.9%** |
| `p99` Latency | `672.18 ms` | **`292.53 ms`** | **-56.5%** |
| Error Rate | `0%` (`0 / 1,000`) | **`0%` (`0 / 1,000`)** | `0%` |

*(Note: The zero-sleep synthetic burst in `scripts/benchmark.ts` fires 100 unpaced simultaneous requests per wave; under realistic `k6` 100-VU load with `100 ms` pacing, `p95` is **`116.00 ms`**.)*

---

## 3. Native PostgreSQL 16 Concurrency Verification (`pg.Pool`, `PG_POOL_MAX=30`)

Verified via independent HTTP `fetch()` requests hitting Express + `pg.Pool` against PostgreSQL 16.16 (`tests/integration/crewforge.test.ts`):

- **50 Users Competing for 1 Seat (Test #23)**: `1` × `200 OK`, `49` × `409 TEAM_AT_CAPACITY`, `0` × `5xx`; `member_count == 2 == COUNT(*)` (`5,958 ms`).
- **100 Users Competing for 5 Seats (Test #29)**: `5` × `200 OK`, `95` × `409 TEAM_AT_CAPACITY`, `0` × `5xx`; `member_count == 6 == COUNT(*)`; `0` duplicate memberships (`11,963 ms`).
- **50 Simultaneous Retries with Same `Idempotency-Key` (Tests #24 & #30)**: `50 / 50` identical response (`1` created/joined, `49` `X-Idempotent-Replay: true`), `0` duplicate teams or memberships.
- **10 Simultaneous Duplicate Join Requests (Test #25)**: `1` × `201 Created`, `9` × `409 DUPLICATE_REQUEST`, `1` pending row in DB.
