-- CrewForge PostgreSQL Schema Migration 003
-- Partial covering indexes tailored for high-concurrency open-seats discovery queries

CREATE INDEX IF NOT EXISTS idx_teams_open_seats_created
  ON teams (created_at DESC)
  WHERE is_demo_sandbox = FALSE AND member_count < max_capacity AND status <> 'locked';

CREATE INDEX IF NOT EXISTS idx_teams_open_seats_hackathon
  ON teams (hackathon_id, created_at DESC)
  WHERE is_demo_sandbox = FALSE AND member_count < max_capacity AND status <> 'locked';
