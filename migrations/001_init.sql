-- CrewForge PostgreSQL Schema Migration 001
-- Race-Proof Hackathon Team Formation Platform

-- Uses PostgreSQL 13+ built-in gen_random_uuid()

-- 1. Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid TEXT UNIQUE,
  full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'participant' CHECK (role IN ('participant', 'organizer', 'admin')),
  bio TEXT NOT NULL DEFAULT '',
  skills TEXT[] NOT NULL DEFAULT '{}',
  experience_level TEXT NOT NULL DEFAULT 'intermediate' CHECK (experience_level IN ('beginner', 'intermediate', 'advanced', 'staff')),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_skills_gin ON users USING GIN (skills);
CREATE INDEX IF NOT EXISTS idx_users_timezone ON users (timezone);

-- 2. Hackathons
CREATE TABLE IF NOT EXISTS hackathons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 3 AND 140),
  description TEXT NOT NULL DEFAULT '',
  registration_status TEXT NOT NULL DEFAULT 'open' CHECK (registration_status IN ('draft', 'open', 'closed')),
  team_formation_status TEXT NOT NULL DEFAULT 'open' CHECK (team_formation_status IN ('open', 'locked', 'closed')),
  min_team_size INT NOT NULL DEFAULT 2 CHECK (min_team_size >= 1),
  max_team_size INT NOT NULL DEFAULT 4 CHECK (max_team_size >= min_team_size AND max_team_size <= 20),
  is_demo_sandbox BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Teams (denormalized member_count maintained transactionally + checked against max_capacity)
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  description TEXT NOT NULL DEFAULT '',
  leader_id UUID NOT NULL REFERENCES users(id),
  member_count INT NOT NULL DEFAULT 1 CHECK (member_count >= 0),
  max_capacity INT NOT NULL CHECK (max_capacity >= 1),
  required_skills TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'forming' CHECK (status IN ('forming', 'ready', 'locked')),
  is_demo_sandbox BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_teams_hackathon_name UNIQUE (hackathon_id, name),
  CONSTRAINT chk_teams_capacity CHECK (member_count <= max_capacity)
);

CREATE INDEX IF NOT EXISTS idx_teams_discovery ON teams (hackathon_id, status, member_count, max_capacity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_teams_skills_gin ON teams USING GIN (required_skills);

-- 4. Team Members (UNIQUE (hackathon_id, user_id) enforces 1 team per user per hackathon)
CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('leader', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_team_members_hackathon_user UNIQUE (hackathon_id, user_id),
  CONSTRAINT uq_team_members_team_user UNIQUE (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_team_joined ON team_members (team_id, joined_at ASC);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id, hackathon_id);

-- 5. Join Requests
CREATE TABLE IF NOT EXISTS join_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  reviewed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_join_requests_pending_unique
  ON join_requests (team_id, user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_join_requests_team_status
  ON join_requests (team_id, status, created_at DESC);

-- 6. Secure Invitation Codes (only SHA-256 hash stored, never plaintext)
CREATE TABLE IF NOT EXISTS invite_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  code_prefix TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  max_uses INT NOT NULL DEFAULT 10 CHECK (max_uses >= 1),
  uses_count INT NOT NULL DEFAULT 0 CHECK (uses_count >= 0 AND uses_count <= max_uses),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_team ON invite_codes (team_id, created_at DESC);

-- 7. Idempotency Keys
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INT NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  CONSTRAINT uq_idempotency_scope_key UNIQUE (scope_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);

-- 8. Audit Logs (intentionally NO foreign key cascade on team_id so audit history survives team deletion)
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  team_id UUID,
  hackathon_id UUID,
  action TEXT NOT NULL,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_team_created ON audit_logs (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC);
