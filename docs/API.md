# REST API & Realtime Event Reference (`docs/API.md`)

## Health & Realtime

- `GET /api/health` — Database readiness, engine mode, active SSE subscriber count.
- `GET /api/events/stream` — Server-Sent Events stream backed by PostgreSQL `LISTEN/NOTIFY` (`TEAM_CREATED`, `TEAM_UPDATED`, `MEMBER_JOINED`, `MEMBER_LEFT`, `MEMBER_REMOVED`, `LEADER_CHANGED`, `TEAM_DELETED`, `JOIN_REQUEST_CREATED`, `JOIN_REQUEST_UPDATED`).

## Authentication

- `POST /api/auth/register` — Register participant account (`fullName`, `email`, `password`, `bio`, `skills`, `experienceLevel`, `timezone`).
- `POST /api/auth/login` — Authenticate and receive HTTP-only cookie + token.
- `POST /api/auth/firebase` — Exchange Firebase ID token for CrewForge session.
- `POST /api/auth/logout` — Clear session cookie.
- `GET /api/auth/session` — Non-failing session check returning `{ user, memberships }` or `{ user: null, memberships: [] }`.
- `GET /api/auth/me` — Current user profile + active hackathon memberships (returns `401` if unauthenticated).
- `PATCH /api/auth/profile` — Update profile fields.

## Hackathons

- `GET /api/hackathons` — List active hackathons with team and participant counts.
- `POST /api/hackathons` — Create hackathon (Organizer/Admin, supports `Idempotency-Key`).
- `PATCH /api/hackathons/:id` — Update hackathon metadata, team size bounds, or team formation status (Organizer/Admin).

## Teams & Race-Safe Membership

- `GET /api/teams` — Paginated discovery board (`hackathonId`, `status`, `skill`, `q`, `openOnly`, `page`, `limit`).
- `GET /api/teams/:id` — Team details, member roster, leader-only pending join requests & invite metadata.
- `POST /api/teams` — Create team (supports `Idempotency-Key`).
- `PATCH /api/teams/:id` — Update team details/status/capacity (Leader/Admin, supports `Idempotency-Key`).
- `DELETE /api/teams/:id` — Delete team (Leader/Admin, retains audit logs).
- `POST /api/teams/:id/join` — Claim open seat directly or redeem `inviteCode` (supports `Idempotency-Key`).
- `POST /api/teams/:id/leave` — Leave team (auto-transfers leadership to earliest-joined member or deletes team if last member).
- `DELETE /api/teams/:id/members/:userId` — Remove member (Leader/Admin).
- `POST /api/teams/:id/transfer-leadership` — Explicit leadership transfer (Leader/Admin).
- `POST /api/teams/:id/join-requests` — Submit join request (supports `Idempotency-Key`).
- `POST /api/teams/:id/join-requests/:requestId/accept` — 12-step `SELECT FOR UPDATE` acceptance (Leader/Admin, supports `Idempotency-Key`).
- `POST /api/teams/:id/join-requests/:requestId/reject` — Reject request (Leader/Admin, supports `Idempotency-Key`).
- `POST /api/teams/:id/invites` — Generate 256-bit invite token (Leader).
- `DELETE /api/teams/:id/invites/:inviteId` — Revoke active invite (Leader).
- `GET /api/teams/:id/recommendations` — Deterministic 70% skill + 30% timezone teammate matches.

## Audit Explorer & RaceLab

- `GET /api/audit-logs` — Searchable paginated audit history (`teamId`, `action`, `q`, `page`, `limit`).
- `POST /api/racelab/setup` — Provision isolated sandbox team and synthetic competitor tokens (Organizer/Admin).
- `POST /api/racelab/verify/:teamId` — Verify database invariants post-experiment (Organizer/Admin).
