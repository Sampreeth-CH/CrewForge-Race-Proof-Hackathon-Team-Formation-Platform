import { DbClient } from '../db/client.ts';

export type AuditAction =
  | 'TEAM_CREATED'
  | 'TEAM_UPDATED'
  | 'TEAM_DELETED'
  | 'MEMBERSHIP_CREATED'
  | 'JOIN_REQUEST_CREATED'
  | 'JOIN_REQUEST_ACCEPTED'
  | 'JOIN_REQUEST_REJECTED'
  | 'MEMBER_REMOVED'
  | 'MEMBER_LEFT'
  | 'LEADER_TRANSFERRED'
  | 'INVITE_CREATED'
  | 'INVITE_REVOKED'
  | 'INVITE_REDEEMED'
  | 'RACE_LAB_RUN';

export interface AuditLogInput {
  actorId: string | null;
  teamId?: string | null;
  hackathonId?: string | null;
  action: AuditAction;
  targetUserId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function insertAuditLog(tx: DbClient, input: AuditLogInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs (actor_id, team_id, hackathon_id, action, target_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.actorId,
      input.teamId ?? null,
      input.hackathonId ?? null,
      input.action,
      input.targetUserId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
}
