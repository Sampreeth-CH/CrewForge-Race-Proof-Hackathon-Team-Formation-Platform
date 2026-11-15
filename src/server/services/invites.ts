import crypto from 'node:crypto';
import { DbClient } from '../db/client.ts';
import { AppError } from '../errors.ts';
import { insertAuditLog } from './audit.ts';

export function hashInviteCode(rawCode: string): string {
  return crypto.createHash('sha256').update(rawCode).digest('hex');
}

export function generateSecureInviteToken(): {
  rawCode: string;
  codeHash: string;
  codePrefix: string;
} {
  // 32 random bytes = 256 bits of cryptographic entropy
  const randomPart = crypto.randomBytes(32).toString('base64url');
  const rawCode = `cf_${randomPart}`;
  const codeHash = hashInviteCode(rawCode);
  const codePrefix = rawCode.slice(0, 10);
  return { rawCode, codeHash, codePrefix };
}

export async function createTeamInvite(
  tx: DbClient,
  params: {
    teamId: string;
    actorId: string;
    actorRole?: string;
    expiresInHours: number;
    maxUses: number;
  }
) {
  const teamRes = await tx.query<{
    id: string;
    hackathon_id: string;
    leader_id: string;
    name: string;
  }>('SELECT id, hackathon_id, leader_id, name FROM teams WHERE id = $1 FOR UPDATE', [
    params.teamId,
  ]);

  if (teamRes.rows.length === 0) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
  }
  const team = teamRes.rows[0];

  const isLeaderOrAdmin = team.leader_id === params.actorId || params.actorRole === 'admin';
  if (!isLeaderOrAdmin) {
    throw new AppError(403, 'FORBIDDEN', 'Only the team leader can generate invitation codes.');
  }

  const { rawCode, codeHash, codePrefix } = generateSecureInviteToken();
  const expiresAt = new Date(Date.now() + params.expiresInHours * 3600 * 1000);

  const inserted = await tx.query<{
    id: string;
    team_id: string;
    code_prefix: string;
    max_uses: number;
    uses_count: number;
    expires_at: string;
    created_at: string;
  }>(
    `INSERT INTO invite_codes (team_id, hackathon_id, code_hash, code_prefix, created_by, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, team_id, code_prefix, max_uses, uses_count, expires_at, created_at`,
    [
      team.id,
      team.hackathon_id,
      codeHash,
      codePrefix,
      params.actorId,
      params.maxUses,
      expiresAt.toISOString(),
    ]
  );

  await insertAuditLog(tx, {
    actorId: params.actorId,
    teamId: team.id,
    hackathonId: team.hackathon_id,
    action: 'INVITE_CREATED',
    metadata: {
      inviteId: inserted.rows[0].id,
      codePrefix,
      maxUses: params.maxUses,
      expiresAt: expiresAt.toISOString(),
    },
  });

  // Return rawCode ONCE to the authorized caller; it is never stored in plaintext
  return {
    ...inserted.rows[0],
    code: rawCode,
  };
}

export async function revokeTeamInvite(
  tx: DbClient,
  params: {
    teamId: string;
    inviteId: string;
    actorId: string;
    actorRole?: string;
  }
) {
  const teamRes = await tx.query<{ id: string; hackathon_id: string; leader_id: string }>(
    'SELECT id, hackathon_id, leader_id FROM teams WHERE id = $1 FOR UPDATE',
    [params.teamId]
  );
  if (teamRes.rows.length === 0) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
  }
  const team = teamRes.rows[0];
  if (team.leader_id !== params.actorId && params.actorRole !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the team leader can revoke invitation codes.');
  }

  const updated = await tx.query<{ id: string; code_prefix: string; revoked_at: string }>(
    `UPDATE invite_codes
     SET revoked_at = NOW()
     WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL
     RETURNING id, code_prefix, revoked_at`,
    [params.inviteId, params.teamId]
  );

  if (updated.rows.length === 0) {
    throw new AppError(404, 'INVITE_NOT_FOUND', 'Active invitation code not found.');
  }

  await insertAuditLog(tx, {
    actorId: params.actorId,
    teamId: team.id,
    hackathonId: team.hackathon_id,
    action: 'INVITE_REVOKED',
    metadata: {
      inviteId: params.inviteId,
      codePrefix: updated.rows[0].code_prefix,
    },
  });

  return updated.rows[0];
}
