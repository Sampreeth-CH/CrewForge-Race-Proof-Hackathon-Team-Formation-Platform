-- CrewForge PostgreSQL Schema Migration 002
-- Case-insensitive team name uniqueness + high-throughput discovery & audit indexes

CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_hackathon_name_lower
  ON teams (hackathon_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_teams_public_created
  ON teams (created_at DESC)
  WHERE is_demo_sandbox = FALSE;

CREATE INDEX IF NOT EXISTS idx_teams_public_open
  ON teams (hackathon_id, status, created_at DESC)
  WHERE is_demo_sandbox = FALSE;

CREATE INDEX IF NOT EXISTS idx_audit_logs_team_action
  ON audit_logs (team_id, action, created_at DESC);
