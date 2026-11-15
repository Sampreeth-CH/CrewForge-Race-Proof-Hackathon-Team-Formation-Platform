import { DatabaseManager, DbClient } from '../db/client.ts';
import { AppError, isPgError } from '../errors.ts';
import { insertAuditLog } from './audit.ts';
import { CREWFORGE_CHANNEL, RealtimeEvent } from './sse.ts';
import { hashInviteCode } from './invites.ts';
import { canMarkTeamReady } from '../../shared/logic.ts';

export interface TeamRow {
  id: string;
  hackathon_id: string;
  name: string;
  description: string;
  leader_id: string;
  member_count: number;
  max_capacity: number;
  required_skills: string[];
  status: 'forming' | 'ready' | 'locked';
  is_demo_sandbox: boolean;
  created_at: string;
  updated_at: string;
}

export interface HackathonRow {
  id: string;
  slug: string;
  name: string;
  min_team_size: number;
  max_team_size: number;
  registration_status: string;
  team_formation_status: string;
  is_demo_sandbox: boolean;
}

async function emitRealtimeInTx(
  db: DatabaseManager,
  tx: DbClient,
  event: Omit<RealtimeEvent, 'timestamp'>
) {
  await db.notifyInTx(tx, CREWFORGE_CHANNEL, {
    ...event,
    timestamp: new Date().toISOString(),
  });
}

function mapPgMembershipError(err: unknown): never {
  if (isPgError(err)) {
    if (err.code === '23505') {
      if (err.constraint?.includes('hackathon_user')) {
        throw new AppError(
          409,
          'ALREADY_IN_TEAM',
          'User already belongs to a team in this hackathon.'
        );
      }
      if (err.constraint?.includes('hackathon_name')) {
        throw new AppError(
          409,
          'DUPLICATE_TEAM_NAME',
          'A team with this name already exists in this hackathon.'
        );
      }
      throw new AppError(409, 'CONFLICT', 'Resource conflict detected.');
    }
    if (err.code === '23514' && err.constraint?.includes('capacity')) {
      throw new AppError(409, 'TEAM_AT_CAPACITY', 'Team has reached maximum capacity.');
    }
  }
  throw err;
}

export async function createTeamInTx(
  db: DatabaseManager,
  tx: DbClient,
  params: {
    hackathonId: string;
    actorId: string;
    name: string;
    description: string;
    maxCapacity?: number;
    requiredSkills: string[];
    isDemoSandbox?: boolean;
  }
) {
  try {
    const hackRes = await tx.query<HackathonRow>(
      'SELECT * FROM hackathons WHERE id = $1 FOR SHARE',
      [params.hackathonId]
    );
    if (hackRes.rows.length === 0) {
      throw new AppError(404, 'HACKATHON_NOT_FOUND', 'Hackathon not found.');
    }
    const hackathon = hackRes.rows[0];
    if (hackathon.team_formation_status !== 'open') {
      throw new AppError(
        409,
        'TEAM_FORMATION_CLOSED',
        'Team formation is currently closed for this hackathon.'
      );
    }

    const capacity = params.maxCapacity ?? hackathon.max_team_size;
    if (capacity < hackathon.min_team_size || capacity > hackathon.max_team_size) {
      throw new AppError(
        400,
        'INVALID_CAPACITY',
        `Team max capacity must be between ${hackathon.min_team_size} and ${hackathon.max_team_size}.`
      );
    }

    const existingMembership = await tx.query<{ team_id: string }>(
      'SELECT team_id FROM team_members WHERE hackathon_id = $1 AND user_id = $2',
      [params.hackathonId, params.actorId]
    );
    if (existingMembership.rows.length > 0) {
      throw new AppError(
        409,
        'ALREADY_IN_TEAM',
        'User already belongs to a team in this hackathon.'
      );
    }

    const existingName = await tx.query<{ id: string }>(
      'SELECT id FROM teams WHERE hackathon_id = $1 AND LOWER(name) = LOWER($2)',
      [params.hackathonId, params.name.trim()]
    );
    if (existingName.rows.length > 0) {
      throw new AppError(
        409,
        'DUPLICATE_TEAM_NAME',
        'A team with this name already exists in this hackathon.'
      );
    }

    const initialStatus = capacity <= 1 && hackathon.min_team_size <= 1 ? 'ready' : 'forming';

    const teamInsert = await tx.query<TeamRow>(
      `INSERT INTO teams (
        hackathon_id, name, description, leader_id, member_count, max_capacity,
        required_skills, status, is_demo_sandbox
      ) VALUES ($1, $2, $3, $4, 1, $5, $6::text[], $7, $8)
      RETURNING *`,
      [
        params.hackathonId,
        params.name.trim(),
        params.description.trim(),
        params.actorId,
        capacity,
        params.requiredSkills,
        initialStatus,
        Boolean(params.isDemoSandbox || hackathon.is_demo_sandbox),
      ]
    );
    const team = teamInsert.rows[0];

    await tx.query(
      `INSERT INTO team_members (team_id, hackathon_id, user_id, role)
       VALUES ($1, $2, $3, 'leader')`,
      [team.id, params.hackathonId, params.actorId]
    );

    await insertAuditLog(tx, {
      actorId: params.actorId,
      teamId: team.id,
      hackathonId: team.hackathon_id,
      action: 'TEAM_CREATED',
      targetUserId: params.actorId,
      metadata: {
        name: team.name,
        maxCapacity: team.max_capacity,
        requiredSkills: team.required_skills,
      },
    });

    await emitRealtimeInTx(db, tx, {
      type: 'TEAM_CREATED',
      hackathonId: team.hackathon_id,
      teamId: team.id,
      payload: {
        id: team.id,
        name: team.name,
        memberCount: team.member_count,
        maxCapacity: team.max_capacity,
        status: team.status,
      },
    });

    return team;
  } catch (err) {
    mapPgMembershipError(err);
  }
}

export async function updateTeamInTx(
  db: DatabaseManager,
  tx: DbClient,
  params: {
    teamId: string;
    actorId: string;
    actorRole: string;
    name?: string;
    description?: string;
    maxCapacity?: number;
    requiredSkills?: string[];
    status?: 'forming' | 'ready' | 'locked';
  }
) {
  try {
    const teamRes = await tx.query<TeamRow>(
      'SELECT * FROM teams WHERE id = $1 FOR UPDATE',
      [params.teamId]
    );
    if (teamRes.rows.length === 0) {
      throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
    }
    const team = teamRes.rows[0];

    if (team.leader_id !== params.actorId && params.actorRole !== 'admin') {
      throw new AppError(403, 'FORBIDDEN', 'Only the team leader can update team settings.');
    }

    const hackRes = await tx.query<HackathonRow>(
      'SELECT * FROM hackathons WHERE id = $1',
      [team.hackathon_id]
    );
    const hackathon = hackRes.rows[0];

    const nextCapacity = params.maxCapacity ?? team.max_capacity;
    if (nextCapacity < team.member_count) {
      throw new AppError(
        409,
        'CAPACITY_BELOW_MEMBERS',
        `Cannot reduce capacity to ${nextCapacity} below current member count (${team.member_count}).`
      );
    }
    if (nextCapacity < hackathon.min_team_size || nextCapacity > hackathon.max_team_size) {
      throw new AppError(
        400,
        'INVALID_CAPACITY',
        `Team capacity must be between ${hackathon.min_team_size} and ${hackathon.max_team_size}.`
      );
    }

    const nextStatus = params.status ?? team.status;
    if (nextStatus === 'ready') {
      const readiness = canMarkTeamReady(team.member_count, hackathon.min_team_size);
      if (!readiness.allowed) {
        throw new AppError(409, 'MIN_TEAM_SIZE_NOT_MET', readiness.reason!);
      }
    }

    const updatedRes = await tx.query<TeamRow>(
      `UPDATE teams
       SET name = $2,
           description = $3,
           max_capacity = $4,
           required_skills = $5::text[],
           status = $6,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        team.id,
        params.name !== undefined ? params.name.trim() : team.name,
        params.description !== undefined ? params.description.trim() : team.description,
        nextCapacity,
        params.requiredSkills !== undefined ? params.requiredSkills : team.required_skills,
        nextStatus,
      ]
    );
    const updated = updatedRes.rows[0];

    await insertAuditLog(tx, {
      actorId: params.actorId,
      teamId: updated.id,
      hackathonId: updated.hackathon_id,
      action: 'TEAM_UPDATED',
      metadata: {
        status: updated.status,
        maxCapacity: updated.max_capacity,
      },
    });

    await emitRealtimeInTx(db, tx, {
      type: 'TEAM_UPDATED',
      hackathonId: updated.hackathon_id,
      teamId: updated.id,
      payload: {
        id: updated.id,
        name: updated.name,
        memberCount: updated.member_count,
        maxCapacity: updated.max_capacity,
        status: updated.status,
      },
    });

    return updated;
  } catch (err) {
    mapPgMembershipError(err);
  }
}

export async function deleteTeamInTx(
  db: DatabaseManager,
  tx: DbClient,
  params: {
    teamId: string;
    actorId: string;
    actorRole: string;
  }
) {
  const teamRes = await tx.query<TeamRow>(
    'SELECT * FROM teams WHERE id = $1 FOR UPDATE',
    [params.teamId]
  );
  if (teamRes.rows.length === 0) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
  }
  const team = teamRes.rows[0];

  if (team.leader_id !== params.actorId && params.actorRole !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the team leader or an admin can delete this team.');
  }

  await insertAuditLog(tx, {
    actorId: params.actorId,
    teamId: team.id,
    hackathonId: team.hackathon_id,
    action: 'TEAM_DELETED',
    metadata: {
      teamName: team.name,
      previousMemberCount: team.member_count,
    },
  });

  await tx.query('DELETE FROM teams WHERE id = $1', [team.id]);

  await emitRealtimeInTx(db, tx, {
    type: 'TEAM_DELETED',
    hackathonId: team.hackathon_id,
    teamId: team.id,
    payload: { id: team.id, name: team.name },
  });

  return { deleted: true, teamId: team.id };
}

/**
 * Core Race-Safe Seat Acquisition Engine
 * Follows the exact 12-step SELECT ... FOR UPDATE protocol.
 */
export async function acceptJoinRequestInTx(
  db: DatabaseManager,
  tx: DbClient,
  params: {
    teamId: string;
    requestId: string;
    actorId: string;
    actorRole: string;
  }
) {
  try {
    // 2. Lock the associated team row using SELECT FOR UPDATE
    const teamRes = await tx.query<TeamRow>(
      'SELECT * FROM teams WHERE id = $1 FOR UPDATE',
      [params.teamId]
    );
    // 3. Verify the team exists and is accepting members
    if (teamRes.rows.length === 0) {
      throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
    }
    const team = teamRes.rows[0];

    if (team.leader_id !== params.actorId && params.actorRole !== 'admin') {
      throw new AppError(403, 'FORBIDDEN', 'Only the team leader can accept join requests.');
    }
    const hackRes = await tx.query<{ team_formation_status: string }>(
      'SELECT team_formation_status FROM hackathons WHERE id = $1 FOR SHARE',
      [team.hackathon_id]
    );
    if (hackRes.rows[0]?.team_formation_status !== 'open') {
      throw new AppError(
        409,
        'TEAM_FORMATION_CLOSED',
        'Team formation is currently closed for this hackathon.'
      );
    }
    if (team.status === 'locked') {
      throw new AppError(409, 'TEAM_LOCKED', 'Team is locked and not accepting new members.');
    }

    // 4. Check current membership capacity
    if (team.member_count >= team.max_capacity) {
      throw new AppError(409, 'TEAM_AT_CAPACITY', 'Team has reached maximum capacity.');
    }

    // 6. Verify the join request is pending (locked FOR UPDATE)
    const reqRes = await tx.query<{
      id: string;
      team_id: string;
      hackathon_id: string;
      user_id: string;
      status: string;
    }>(
      'SELECT * FROM join_requests WHERE id = $1 AND team_id = $2 FOR UPDATE',
      [params.requestId, params.teamId]
    );
    if (reqRes.rows.length === 0) {
      throw new AppError(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found.');
    }
    const joinRequest = reqRes.rows[0];
    if (joinRequest.status !== 'pending') {
      throw new AppError(
        409,
        'JOIN_REQUEST_NOT_PENDING',
        `Join request is already ${joinRequest.status}.`
      );
    }

    // 5. Check that the user has not joined another team in the hackathon
    const existingMember = await tx.query<{ team_id: string }>(
      'SELECT team_id FROM team_members WHERE hackathon_id = $1 AND user_id = $2',
      [team.hackathon_id, joinRequest.user_id]
    );
    if (existingMember.rows.length > 0) {
      throw new AppError(
        409,
        'ALREADY_IN_TEAM',
        'Candidate already belongs to a team in this hackathon.'
      );
    }

    // 7. Insert the membership (protected independently by UNIQUE (hackathon_id, user_id))
    const memberInsert = await tx.query<{ id: string; joined_at: string }>(
      `INSERT INTO team_members (team_id, hackathon_id, user_id, role)
       VALUES ($1, $2, $3, 'member')
       RETURNING id, joined_at`,
      [team.id, team.hackathon_id, joinRequest.user_id]
    );

    // 8. Increment member_count atomically
    const updatedTeamRes = await tx.query<TeamRow>(
      `UPDATE teams
       SET member_count = member_count + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [team.id]
    );
    const updatedTeam = updatedTeamRes.rows[0];

    // 9. Update the join request status
    await tx.query(
      `UPDATE join_requests
       SET status = 'accepted', reviewed_by = $2, updated_at = NOW()
       WHERE id = $1`,
      [joinRequest.id, params.actorId]
    );

    // Withdraw any other pending join requests from this user in the same hackathon
    await tx.query(
      `UPDATE join_requests
       SET status = 'withdrawn', updated_at = NOW()
       WHERE hackathon_id = $1 AND user_id = $2 AND status = 'pending' AND id <> $3`,
      [team.hackathon_id, joinRequest.user_id, joinRequest.id]
    );

    // 10. Insert audit logs
    await insertAuditLog(tx, {
      actorId: params.actorId,
      teamId: team.id,
      hackathonId: team.hackathon_id,
      action: 'JOIN_REQUEST_ACCEPTED',
      targetUserId: joinRequest.user_id,
      metadata: {
        joinRequestId: joinRequest.id,
        newMemberCount: updatedTeam.member_count,
      },
    });
    await insertAuditLog(tx, {
      actorId: params.actorId,
      teamId: team.id,
      hackathonId: team.hackathon_id,
      action: 'MEMBERSHIP_CREATED',
      targetUserId: joinRequest.user_id,
      metadata: {
        source: 'join_request',
        memberCount: updatedTeam.member_count,
        maxCapacity: updatedTeam.max_capacity,
      },
    });

    // 11. Publish PostgreSQL notification inside transaction
    await emitRealtimeInTx(db, tx, {
      type: 'JOIN_REQUEST_UPDATED',
      hackathonId: team.hackathon_id,
      teamId: team.id,
      payload: { requestId: joinRequest.id, status: 'accepted', userId: joinRequest.user_id },
    });
    await emitRealtimeInTx(db, tx, {
      type: 'MEMBER_JOINED',
      hackathonId: team.hackathon_id,
      teamId: team.id,
      payload: {
        teamId: team.id,
        userId: joinRequest.user_id,
        memberCount: updatedTeam.member_count,
        maxCapacity: updatedTeam.max_capacity,
      },
    });

    return {
      team: updatedTeam,
      membershipId: memberInsert.rows[0].id,
      joinedAt: memberInsert.rows[0].joined_at,
    };
  } catch (err) {
    mapPgMembershipError(err);
  }
}

/**
 * Race-Safe Direct Join (used for open team join and RaceLab 50-user simultaneous seat race)
 */
export async function directJoinTeamInTx(
  db: DatabaseManager,
  tx: DbClient,
  params: {
    teamId: string;
    userId: string;
    inviteCode?: string;
    source?: 'direct' | 'invite' | 'racelab';
  }
) {
  try {
    // 1 & 2. Lock team row FOR UPDATE
    const teamRes = await tx.query<TeamRow>(
      'SELECT * FROM teams WHERE id = $1 FOR UPDATE',
      [params.teamId]
    );
    if (teamRes.rows.length === 0) {
      throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
    }
    const team = teamRes.rows[0];

    // 3. Verify hackathon & team accept members
    const hackRes = await tx.query<{ team_formation_status: string }>(
      'SELECT team_formation_status FROM hackathons WHERE id = $1 FOR SHARE',
      [team.hackathon_id]
    );
    if (hackRes.rows[0]?.team_formation_status !== 'open') {
      throw new AppError(
        409,
        'TEAM_FORMATION_CLOSED',
        'Team formation is currently closed for this hackathon.'
      );
    }
    if (team.status === 'locked') {
      throw new AppError(409, 'TEAM_LOCKED', 'Team is locked and not accepting members.');
    }

    let inviteId: string | null = null;
    if (params.inviteCode) {
      const codeHash = hashInviteCode(params.inviteCode.trim());
      const invRes = await tx.query<{
        id: string;
        team_id: string;
        max_uses: number;
        uses_count: number;
        expires_at: string;
        revoked_at: string | null;
      }>('SELECT * FROM invite_codes WHERE code_hash = $1 FOR UPDATE', [codeHash]);

      if (invRes.rows.length === 0) {
        throw new AppError(404, 'INVALID_INVITE', 'Invitation code is invalid.');
      }
      const inv = invRes.rows[0];
      if (inv.team_id !== team.id) {
        throw new AppError(400, 'INVITE_TEAM_MISMATCH', 'Invitation code belongs to another team.');
      }
      if (inv.revoked_at) {
        throw new AppError(410, 'INVITE_REVOKED', 'Invitation code has been revoked.');
      }
      if (new Date(inv.expires_at).getTime() <= Date.now()) {
        throw new AppError(410, 'INVITE_EXPIRED', 'Invitation code has expired.');
      }
      if (inv.uses_count >= inv.max_uses) {
        throw new AppError(409, 'INVITE_EXHAUSTED', 'Invitation code usage limit reached.');
      }
      inviteId = inv.id;
    }

    // 4. Verify capacity
    if (team.member_count >= team.max_capacity) {
      throw new AppError(409, 'TEAM_AT_CAPACITY', 'Team has reached maximum capacity.');
    }

    // 5. Verify user has not joined another team in the hackathon
    const existingMember = await tx.query<{ team_id: string }>(
      'SELECT team_id FROM team_members WHERE hackathon_id = $1 AND user_id = $2',
      [team.hackathon_id, params.userId]
    );
    if (existingMember.rows.length > 0) {
      throw new AppError(
        409,
        'ALREADY_IN_TEAM',
        'User already belongs to a team in this hackathon.'
      );
    }

    // 6. Insert membership
    const memberInsert = await tx.query<{ id: string; joined_at: string }>(
      `INSERT INTO team_members (team_id, hackathon_id, user_id, role)
       VALUES ($1, $2, $3, 'member')
       RETURNING id, joined_at`,
      [team.id, team.hackathon_id, params.userId]
    );

    // 7. Increment member_count
    const updatedTeamRes = await tx.query<TeamRow>(
      `UPDATE teams
       SET member_count = member_count + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [team.id]
    );
    const updatedTeam = updatedTeamRes.rows[0];

    if (inviteId) {
      await tx.query('UPDATE invite_codes SET uses_count = uses_count + 1 WHERE id = $1', [
        inviteId,
      ]);
      await insertAuditLog(tx, {
        actorId: params.userId,
        teamId: team.id,
        hackathonId: team.hackathon_id,
        action: 'INVITE_REDEEMED',
        targetUserId: params.userId,
        metadata: { inviteId },
      });
    }

    // Withdraw pending requests for this user in this hackathon
    await tx.query(
      `UPDATE join_requests
       SET status = 'withdrawn', updated_at = NOW()
       WHERE hackathon_id = $1 AND user_id = $2 AND status = 'pending'`,
      [team.hackathon_id, params.userId]
    );

    await insertAuditLog(tx, {
      actorId: params.userId,
      teamId: team.id,
      hackathonId: team.hackathon_id,
      action: 'MEMBERSHIP_CREATED',
      targetUserId: params.userId,
      metadata: {
        source: params.source ?? (inviteId ? 'invite' : 'direct'),
        memberCount: updatedTeam.member_count,
        maxCapacity: updatedTeam.max_capacity,
      },
    });

    await emitRealtimeInTx(db, tx, {
      type: 'MEMBER_JOINED',
      hackathonId: team.hackathon_id,
      teamId: team.id,
      payload: {
        teamId: team.id,
        userId: params.userId,
        memberCount: updatedTeam.member_count,
        maxCapacity: updatedTeam.max_capacity,
      },
    });

    return {
      team: updatedTeam,
      membershipId: memberInsert.rows[0].id,
      joinedAt: memberInsert.rows[0].joined_at,
    };
  } catch (err) {
    mapPgMembershipError(err);
  }
}

export async function createJoinRequestInTx(
  db: DatabaseManager,
  tx: DbClient,
  params: {
    teamId: string;
    userId: string;
    message: string;
  }
) {
  try {
    const teamRes = await tx.query<TeamRow>(
      'SELECT * FROM teams WHERE id = $1 FOR UPDATE',
      [params.teamId]
    );
    if (teamRes.rows.length === 0) {
      throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
    }
    const team = teamRes.rows[0];
    const hackRes = await tx.query<{ team_formation_status: string }>(
      'SELECT team_formation_status FROM hackathons WHERE id = $1 FOR SHARE',
      [team.hackathon_id]
    );
    if (hackRes.rows[0]?.team_formation_status !== 'open') {
      throw new AppError(
        409,
        'TEAM_FORMATION_CLOSED',
        'Team formation is currently closed for this hackathon.'
      );
    }
    if (team.status === 'locked') {
      throw new AppError(409, 'TEAM_LOCKED', 'Team is locked.');
    }
    if (team.member_count >= team.max_capacity) {
      throw new AppError(409, 'TEAM_AT_CAPACITY', 'Team is already at maximum capacity.');
    }

    const existingMember = await tx.query<{ team_id: string }>(
      'SELECT team_id FROM team_members WHERE hackathon_id = $1 AND user_id = $2',
      [team.hackathon_id, params.userId]
    );
    if (existingMember.rows.length > 0) {
      throw new AppError(
        409,
        'ALREADY_IN_TEAM',
        'You already belong to a team in this hackathon.'
      );
    }

    const existingPending = await tx.query<{ id: string }>(
      `SELECT id FROM join_requests
       WHERE team_id = $1 AND user_id = $2 AND status = 'pending'`,
      [team.id, params.userId]
    );
    if (existingPending.rows.length > 0) {
      throw new AppError(409, 'DUPLICATE_REQUEST', 'You already have a pending join request.');
    }

    const inserted = await tx.query<{
      id: string;
      team_id: string;
      hackathon_id: string;
      user_id: string;
      message: string;
      status: string;
      created_at: string;
    }>(
      `INSERT INTO join_requests (team_id, hackathon_id, user_id, message, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [team.id, team.hackathon_id, params.userId, params.message.trim()]
    );

    await insertAuditLog(tx, {
      actorId: params.userId,
      teamId: team.id,
      hackathonId: team.hackathon_id,
      action: 'JOIN_REQUEST_CREATED',
      targetUserId: params.userId,
      metadata: { joinRequestId: inserted.rows[0].id },
    });

    await emitRealtimeInTx(db, tx, {
      type: 'JOIN_REQUEST_CREATED',
      hackathonId: team.hackathon_id,
      teamId: team.id,
      payload: { requestId: inserted.rows[0].id, userId: params.userId },
    });

    return inserted.rows[0];
  } catch (err) {
    mapPgMembershipError(err);
  }
}

export async function rejectJoinRequestInTx(
  db: DatabaseManager,
  tx: DbClient,
  params: {
    teamId: string;
    requestId: string;
    actorId: string;
    actorRole: string;
  }
) {
  const teamRes = await tx.query<TeamRow>(
    'SELECT * FROM teams WHERE id = $1 FOR UPDATE',
    [params.teamId]
  );
  if (teamRes.rows.length === 0) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
  }
  const team = teamRes.rows[0];
  if (team.leader_id !== params.actorId && params.actorRole !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the team leader can reject join requests.');
  }

  const reqRes = await tx.query<{ id: string; user_id: string; status: string }>(
    'SELECT id, user_id, status FROM join_requests WHERE id = $1 AND team_id = $2 FOR UPDATE',
    [params.requestId, params.teamId]
  );
  if (reqRes.rows.length === 0) {
    throw new AppError(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found.');
  }
  const jr = reqRes.rows[0];
  if (jr.status !== 'pending') {
    throw new AppError(409, 'JOIN_REQUEST_NOT_PENDING', `Join request is already ${jr.status}.`);
  }

  const updated = await tx.query(
    `UPDATE join_requests
     SET status = 'rejected', reviewed_by = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [jr.id, params.actorId]
  );

  await insertAuditLog(tx, {
    actorId: params.actorId,
    teamId: team.id,
    hackathonId: team.hackathon_id,
    action: 'JOIN_REQUEST_REJECTED',
    targetUserId: jr.user_id,
    metadata: { joinRequestId: jr.id },
  });

  await emitRealtimeInTx(db, tx, {
    type: 'JOIN_REQUEST_UPDATED',
    hackathonId: team.hackathon_id,
    teamId: team.id,
    payload: { requestId: jr.id, status: 'rejected', userId: jr.user_id },
  });

  return updated.rows[0];
}

export async function leaveTeamInTx(
  db: DatabaseManager,
  tx: DbClient,
  params: {
    teamId: string;
    userId: string;
  }
) {
  const teamRes = await tx.query<TeamRow>(
    'SELECT * FROM teams WHERE id = $1 FOR UPDATE',
    [params.teamId]
  );
  if (teamRes.rows.length === 0) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
  }
  const team = teamRes.rows[0];

  const memberRes = await tx.query<{ id: string; role: string }>(
    'SELECT id, role FROM team_members WHERE team_id = $1 AND user_id = $2',
    [team.id, params.userId]
  );
  if (memberRes.rows.length === 0) {
    throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'You are not a member of this team.');
  }

  await tx.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [
    team.id,
    params.userId,
  ]);

  const remainingRes = await tx.query<{ user_id: string; joined_at: string }>(
    `SELECT user_id, joined_at
     FROM team_members
     WHERE team_id = $1
     ORDER BY joined_at ASC, id ASC`,
    [team.id]
  );

  await insertAuditLog(tx, {
    actorId: params.userId,
    teamId: team.id,
    hackathonId: team.hackathon_id,
    action: 'MEMBER_LEFT',
    targetUserId: params.userId,
    metadata: { remainingMembers: remainingRes.rows.length },
  });

  // Rule: When the last member leaves, delete the team
  if (remainingRes.rows.length === 0) {
    await insertAuditLog(tx, {
      actorId: params.userId,
      teamId: team.id,
      hackathonId: team.hackathon_id,
      action: 'TEAM_DELETED',
      metadata: { reason: 'last_member_left', teamName: team.name },
    });

    await tx.query('DELETE FROM teams WHERE id = $1', [team.id]);

    await emitRealtimeInTx(db, tx, {
      type: 'TEAM_DELETED',
      hackathonId: team.hackathon_id,
      teamId: team.id,
      payload: { id: team.id, reason: 'last_member_left' },
    });

    return { deletedTeam: true, newLeaderId: null, memberCount: 0 };
  }

  const hackRes = await tx.query<HackathonRow>('SELECT * FROM hackathons WHERE id = $1', [
    team.hackathon_id,
  ]);
  const hackathon = hackRes.rows[0];
  const nextCount = remainingRes.rows.length;
  let nextLeaderId = team.leader_id;

  // Rule: When the leader leaves, transfer leadership to the earliest-joined remaining member
  if (team.leader_id === params.userId) {
    nextLeaderId = remainingRes.rows[0].user_id;
    await tx.query(
      `UPDATE team_members SET role = 'leader' WHERE team_id = $1 AND user_id = $2`,
      [team.id, nextLeaderId]
    );

    await insertAuditLog(tx, {
      actorId: params.userId,
      teamId: team.id,
      hackathonId: team.hackathon_id,
      action: 'LEADER_TRANSFERRED',
      targetUserId: nextLeaderId,
      metadata: { previousLeaderId: params.userId, reason: 'leader_left' },
    });
  }

  const nextStatus =
    team.status === 'ready' && nextCount < hackathon.min_team_size ? 'forming' : team.status;

  await tx.query(
    `UPDATE teams
     SET member_count = $2, leader_id = $3, status = $4, updated_at = NOW()
     WHERE id = $1`,
    [team.id, nextCount, nextLeaderId, nextStatus]
  );

  await emitRealtimeInTx(db, tx, {
    type: 'MEMBER_LEFT',
    hackathonId: team.hackathon_id,
    teamId: team.id,
    payload: { userId: params.userId, memberCount: nextCount },
  });

  if (nextLeaderId !== team.leader_id) {
    await emitRealtimeInTx(db, tx, {
      type: 'LEADER_CHANGED',
      hackathonId: team.hackathon_id,
      teamId: team.id,
      payload: { previousLeaderId: params.userId, newLeaderId: nextLeaderId },
    });
  }

  return { deletedTeam: false, newLeaderId: nextLeaderId, memberCount: nextCount };
}

export async function removeMemberInTx(
  db: DatabaseManager,
  tx: DbClient,
  params: {
    teamId: string;
    targetUserId: string;
    actorId: string;
    actorRole: string;
  }
) {
  const teamRes = await tx.query<TeamRow>(
    'SELECT * FROM teams WHERE id = $1 FOR UPDATE',
    [params.teamId]
  );
  if (teamRes.rows.length === 0) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
  }
  const team = teamRes.rows[0];

  if (team.leader_id !== params.actorId && params.actorRole !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the team leader can remove members.');
  }
  if (params.targetUserId === team.leader_id) {
    throw new AppError(
      400,
      'CANNOT_REMOVE_LEADER',
      'Transfer leadership or leave the team instead of removing the leader.'
    );
  }

  const deleted = await tx.query(
    'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2 RETURNING id',
    [team.id, params.targetUserId]
  );
  if (deleted.rows.length === 0) {
    throw new AppError(404, 'MEMBER_NOT_FOUND', 'Target user is not a member of this team.');
  }

  const hackRes = await tx.query<HackathonRow>('SELECT * FROM hackathons WHERE id = $1', [
    team.hackathon_id,
  ]);
  const hackathon = hackRes.rows[0];
  const nextCount = team.member_count - 1;
  const nextStatus =
    team.status === 'ready' && nextCount < hackathon.min_team_size ? 'forming' : team.status;

  const updated = await tx.query<TeamRow>(
    `UPDATE teams
     SET member_count = $2, status = $3, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [team.id, nextCount, nextStatus]
  );

  await insertAuditLog(tx, {
    actorId: params.actorId,
    teamId: team.id,
    hackathonId: team.hackathon_id,
    action: 'MEMBER_REMOVED',
    targetUserId: params.targetUserId,
    metadata: { memberCount: nextCount },
  });

  await emitRealtimeInTx(db, tx, {
    type: 'MEMBER_REMOVED',
    hackathonId: team.hackathon_id,
    teamId: team.id,
    payload: { targetUserId: params.targetUserId, memberCount: nextCount },
  });

  return updated.rows[0];
}

export async function transferLeadershipInTx(
  db: DatabaseManager,
  tx: DbClient,
  params: {
    teamId: string;
    newLeaderId: string;
    actorId: string;
    actorRole: string;
  }
) {
  const teamRes = await tx.query<TeamRow>(
    'SELECT * FROM teams WHERE id = $1 FOR UPDATE',
    [params.teamId]
  );
  if (teamRes.rows.length === 0) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
  }
  const team = teamRes.rows[0];

  if (team.leader_id !== params.actorId && params.actorRole !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only the current leader can transfer leadership.');
  }
  if (params.newLeaderId === team.leader_id) {
    return team;
  }

  const targetMember = await tx.query<{ id: string }>(
    'SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2',
    [team.id, params.newLeaderId]
  );
  if (targetMember.rows.length === 0) {
    throw new AppError(
      400,
      'TARGET_NOT_MEMBER',
      'New leader must already be a member of the team.'
    );
  }

  await tx.query(
    `UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`,
    [team.id, team.leader_id]
  );
  await tx.query(
    `UPDATE team_members SET role = 'leader' WHERE team_id = $1 AND user_id = $2`,
    [team.id, params.newLeaderId]
  );

  const updated = await tx.query<TeamRow>(
    `UPDATE teams SET leader_id = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [team.id, params.newLeaderId]
  );

  await insertAuditLog(tx, {
    actorId: params.actorId,
    teamId: team.id,
    hackathonId: team.hackathon_id,
    action: 'LEADER_TRANSFERRED',
    targetUserId: params.newLeaderId,
    metadata: { previousLeaderId: team.leader_id },
  });

  await emitRealtimeInTx(db, tx, {
    type: 'LEADER_CHANGED',
    hackathonId: team.hackathon_id,
    teamId: team.id,
    payload: { previousLeaderId: team.leader_id, newLeaderId: params.newLeaderId },
  });

  return updated.rows[0];
}
