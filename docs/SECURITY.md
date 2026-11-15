# Security Architecture (`docs/SECURITY.md`)

## Authentication & Sessions

- **Password Hashing**: `bcryptjs` (salt rounds = 10) for user registration; `password_hash` is explicitly omitted from all API serializers.
- **Session Storage**: Signed JWTs stored in `HttpOnly`, `SameSite` cookies (`crewforge_session`) with 24-hour expiration. Explicit `Authorization: Bearer` tokens take precedence over session cookies for API/RaceLab callers. `JWT_SECRET` (minimum 16 characters) is strictly required in `NODE_ENV=production` (ephemeral random secret generated per process in non-production).
- **Firebase Google SSO Bridge**: Optional client-side Google Sign-In verified server-side via `firebase-admin/auth` (`POST /api/auth/firebase`).

## Authorization & RBAC

- Roles: `participant`, `organizer`, `admin`.
- Hackathon creation (`POST /api/hackathons`), hackathon updates (`PATCH /api/hackathons/:id`), and RaceLab sandbox resets (`POST /api/racelab/setup`) require `organizer` or `admin`.
- Team mutations (update settings, accept/reject requests, remove members, transfer leadership, create/revoke invites, delete team) require active team leadership (`team.leader_id === req.user.id`) or `admin` role verified inside the `FOR UPDATE` transaction.

## Cryptographic Invitations

- Generated with `crypto.randomBytes(32)` (256 bits of random entropy), prefixed `cf_`.
- Only the SHA-256 hex digest (`code_hash`) and a short non-secret prefix (`code_prefix`) are persisted in `invite_codes`.
- Supports expiration timestamps (`expires_at`), usage caps (`max_uses`), immediate revocation (`revoked_at`), and Express rate limiting (`inviteBruteForceLimiter` at 15/min + `joinLimiter`).

## Input Validation & HTTP Hardening

- Strict Zod schema validation on every endpoint (including UUID path/query parameters and bounded pagination integers).
- Parameterized SQL queries (`$1, $2, ...`) throughout—zero string concatenation of user input.
- `helmet`, scoped `cors`, and `express-rate-limit` on auth and join/invite routes.
- Hardened `firestore.rules` audited via `@firebase/eslint-plugin-security-rules`.
