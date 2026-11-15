import http from 'node:http';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { DatabaseManager } from '../../src/server/db/client.ts';
import { runMigrations } from '../../src/server/db/migrate.ts';
import { createApp } from '../../src/server/app.ts';
import { CREWFORGE_CHANNEL } from '../../src/server/services/sse.ts';

async function startTestServer(expressApp: ReturnType<typeof createApp>): Promise<http.Server> {
  return await new Promise((resolve) => {
    const srv = expressApp.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

describe('CrewForge Full-Stack PostgreSQL Integration & 50-User Concurrency Suite', () => {
  let db: DatabaseManager;
  let app: ReturnType<typeof createApp>;
  let hackathonId: string;
  let adminToken: string;

  beforeAll(async () => {
    const useExternalPg = Boolean(
      process.env.PGHOST || process.env.SQL_HOST || process.env.DATABASE_URL
    );
    db = new DatabaseManager({ forceMemory: !useExternalPg });
    if (useExternalPg) {
      await db.execRaw(`
        DROP SCHEMA IF EXISTS public CASCADE;
        CREATE SCHEMA public;
      `);
    }
    await runMigrations(db);
    app = createApp(db, { enableRateLimit: false });

    const adminHash = await bcrypt.hash('AdminPass!2026', 8);
    const adminRes = await db.query<{ id: string }>(
      `INSERT INTO users (full_name, email, password_hash, role, skills, experience_level, timezone)
       VALUES ('Test Organizer', 'organizer@test.crewforge.dev', $1, 'admin', ARRAY['PostgreSQL'], 'staff', 'UTC')
       RETURNING id`,
      [adminHash]
    );
    const loginAdmin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'organizer@test.crewforge.dev', password: 'AdminPass!2026' });
    adminToken = loginAdmin.body.token;

    const hackRes = await request(app)
      .post('/api/hackathons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Integration Hackathon 2026',
        minTeamSize: 2,
        maxTeamSize: 4,
      });
    expect(hackRes.status).toBe(201);
    hackathonId = hackRes.body.hackathon.id;
    expect(adminRes.rows[0].id).toBeTruthy();
  });

  afterAll(async () => {
    await db.close();
  });

  async function createUserAndToken(idx: string, opts?: { skills?: string[]; timezone?: string }) {
    const email = `user_${idx}_${Date.now()}@test.crewforge.dev`;
    const res = await request(app).post('/api/auth/register').send({
      fullName: `Engineer ${idx}`,
      email,
      password: 'StrongPassword!123',
      skills: opts?.skills ?? ['TypeScript', 'PostgreSQL'],
      experienceLevel: 'advanced',
      timezone: opts?.timezone ?? 'America/New_York',
    });
    expect(res.status).toBe(201);
    return {
      user: res.body.user as { id: string; email: string; fullName: string },
      token: res.body.token as string,
      email,
    };
  }

  test('1. User registration creates user without exposing password_hash', async () => {
    const res = await request(app).post('/api/auth/register').send({
      fullName: 'Alice Test',
      email: 'alice.reg@test.crewforge.dev',
      password: 'Password!123',
      skills: ['PostgreSQL', 'React'],
      timezone: 'America/Los_Angeles',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('alice.reg@test.crewforge.dev');
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  test('2. Duplicate registration returns 409', async () => {
    const res = await request(app).post('/api/auth/register').send({
      fullName: 'Alice Duplicate',
      email: 'alice.reg@test.crewforge.dev',
      password: 'Password!123',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_EXISTS');
  });

  test('3. Login succeeds and sets HTTP-only cookie', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'alice.reg@test.crewforge.dev',
      password: 'Password!123',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    const rawCookies = res.headers['set-cookie'];
    const cookies = Array.isArray(rawCookies) ? rawCookies : rawCookies ? [rawCookies] : [];
    expect(cookies.some((c: string) => c.includes('crewforge_session=') && c.includes('HttpOnly'))).toBe(true);
  });

  test('4. Invalid authentication returns 401', async () => {
    const badLogin = await request(app).post('/api/auth/login').send({
      email: 'alice.reg@test.crewforge.dev',
      password: 'WrongPassword!',
    });
    expect(badLogin.status).toBe(401);

    const noToken = await request(app).get('/api/auth/me');
    expect(noToken.status).toBe(401);
  });

  test('5 & 6. Team creation and duplicate team name rejection', async () => {
    const leader = await createUserAndToken('t5');
    const createRes = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({
        hackathonId,
        name: 'Vector Squadron',
        description: 'Testing team creation',
        maxCapacity: 3,
        requiredSkills: ['PostgreSQL', 'Go'],
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.team.member_count).toBe(1);

    const leader2 = await createUserAndToken('t6');
    const dupRes = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader2.token}`)
      .send({
        hackathonId,
        name: 'Vector Squadron',
        maxCapacity: 3,
      });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error.code).toBe('DUPLICATE_TEAM_NAME');
  });

  test('7, 8 & 9. Team joining, duplicate hackathon membership protection, and capacity limits', async () => {
    const leader = await createUserAndToken('t7l');
    const u1 = await createUserAndToken('t7u1');
    const u2 = await createUserAndToken('t7u2');

    const teamA = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ hackathonId, name: 'Capacity Squad', maxCapacity: 2 });
    const teamAId = teamA.body.team.id;

    // Join succeeds
    const join1 = await request(app)
      .post(`/api/teams/${teamAId}/join`)
      .set('Authorization', `Bearer ${u1.token}`)
      .send({});
    expect(join1.status).toBe(200);
    expect(join1.body.team.member_count).toBe(2);

    // Capacity exceeded (max 2)
    const join2 = await request(app)
      .post(`/api/teams/${teamAId}/join`)
      .set('Authorization', `Bearer ${u2.token}`)
      .send({});
    expect(join2.status).toBe(409);
    expect(join2.body.error.code).toBe('TEAM_AT_CAPACITY');

    // Duplicate membership in same hackathon (u1 tries creating/joining another team)
    const teamBLeader = await createUserAndToken('t8l');
    const teamB = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${teamBLeader.token}`)
      .send({ hackathonId, name: 'Other Squad', maxCapacity: 3 });

    const dupJoin = await request(app)
      .post(`/api/teams/${teamB.body.team.id}/join`)
      .set('Authorization', `Bearer ${u1.token}`)
      .send({});
    expect(dupJoin.status).toBe(409);
    expect(dupJoin.body.error.code).toBe('ALREADY_IN_TEAM');
  });

  test('10. Minimum team size enforcement when marking ready', async () => {
    const leader = await createUserAndToken('t10');
    const teamRes = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ hackathonId, name: 'MinSize Squad', maxCapacity: 4 });
    const teamId = teamRes.body.team.id;

    const failReady = await request(app)
      .patch(`/api/teams/${teamId}`)
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ status: 'ready' });
    expect(failReady.status).toBe(409);
    expect(failReady.body.error.code).toBe('MIN_TEAM_SIZE_NOT_MET');

    const m1 = await createUserAndToken('t10m');
    await request(app)
      .post(`/api/teams/${teamId}/join`)
      .set('Authorization', `Bearer ${m1.token}`)
      .send({});

    const okReady = await request(app)
      .patch(`/api/teams/${teamId}`)
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ status: 'ready' });
    expect(okReady.status).toBe(200);
    expect(okReady.body.team.status).toBe('ready');
  });

  test('11, 12, 13 & 14. Join requests, acceptance, rejection, and leader-only RBAC', async () => {
    const leader = await createUserAndToken('t11l');
    const c1 = await createUserAndToken('t11c1');
    const c2 = await createUserAndToken('t11c2');

    const teamRes = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ hackathonId, name: 'Request Squad', maxCapacity: 4 });
    const teamId = teamRes.body.team.id;

    const jr1 = await request(app)
      .post(`/api/teams/${teamId}/join-requests`)
      .set('Authorization', `Bearer ${c1.token}`)
      .send({ message: 'PostgreSQL + Go engineer' });
    expect(jr1.status).toBe(201);

    const jr2 = await request(app)
      .post(`/api/teams/${teamId}/join-requests`)
      .set('Authorization', `Bearer ${c2.token}`)
      .send({ message: 'Frontend specialist' });
    expect(jr2.status).toBe(201);

    // Non-leader cannot accept
    const forbidden = await request(app)
      .post(`/api/teams/${teamId}/join-requests/${jr1.body.joinRequest.id}/accept`)
      .set('Authorization', `Bearer ${c2.token}`)
      .send({});
    expect(forbidden.status).toBe(403);

    // Leader accepts c1
    const accepted = await request(app)
      .post(`/api/teams/${teamId}/join-requests/${jr1.body.joinRequest.id}/accept`)
      .set('Authorization', `Bearer ${leader.token}`)
      .send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body.team.member_count).toBe(2);

    // Leader rejects c2
    const rejected = await request(app)
      .post(`/api/teams/${teamId}/join-requests/${jr2.body.joinRequest.id}/reject`)
      .set('Authorization', `Bearer ${leader.token}`)
      .send({});
    expect(rejected.status).toBe(200);
    expect(rejected.body.joinRequest.status).toBe('rejected');
  });

  test('15, 16 & 17. Member removal, automatic leadership transfer on leave, and deletion on final member leave', async () => {
    const leader = await createUserAndToken('t15l');
    const m1 = await createUserAndToken('t15m1');
    const m2 = await createUserAndToken('t15m2');
    const m3 = await createUserAndToken('t15m3');

    const teamRes = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ hackathonId, name: 'Lifecycle Squad', maxCapacity: 4 });
    const teamId = teamRes.body.team.id;

    await request(app).post(`/api/teams/${teamId}/join`).set('Authorization', `Bearer ${m1.token}`).send({});
    await request(app).post(`/api/teams/${teamId}/join`).set('Authorization', `Bearer ${m2.token}`).send({});
    await request(app).post(`/api/teams/${teamId}/join`).set('Authorization', `Bearer ${m3.token}`).send({});

    // Remove m3
    const rmRes = await request(app)
      .delete(`/api/teams/${teamId}/members/${m3.user.id}`)
      .set('Authorization', `Bearer ${leader.token}`);
    expect(rmRes.status).toBe(200);
    expect(rmRes.body.team.member_count).toBe(3);

    // Leader leaves -> earliest joined remaining member (m1) becomes leader
    const leaveLeader = await request(app)
      .post(`/api/teams/${teamId}/leave`)
      .set('Authorization', `Bearer ${leader.token}`);
    expect(leaveLeader.status).toBe(200);
    expect(leaveLeader.body.newLeaderId).toBe(m1.user.id);
    expect(leaveLeader.body.deletedTeam).toBe(false);

    // Remaining members leave -> last member leaving deletes the team
    await request(app).post(`/api/teams/${teamId}/leave`).set('Authorization', `Bearer ${m2.token}`);
    const lastLeave = await request(app)
      .post(`/api/teams/${teamId}/leave`)
      .set('Authorization', `Bearer ${m1.token}`);
    expect(lastLeave.status).toBe(200);
    expect(lastLeave.body.deletedTeam).toBe(true);

    const checkDeleted = await request(app).get(`/api/teams/${teamId}`);
    expect(checkDeleted.status).toBe(404);

    // 20. Audit logs survive team deletion!
    const auditRes = await request(app).get(`/api/audit-logs?teamId=${teamId}`);
    expect(auditRes.status).toBe(200);
    const actions = auditRes.body.logs.map((l: { action: string }) => l.action);
    expect(actions).toContain('TEAM_CREATED');
    expect(actions).toContain('LEADER_TRANSFERRED');
    expect(actions).toContain('TEAM_DELETED');
  });

  test('18. Secure cryptographic invite redemption, expiration, and revocation', async () => {
    const leader = await createUserAndToken('t18l');
    const joiner = await createUserAndToken('t18j');
    const joiner2 = await createUserAndToken('t18j2');

    const teamRes = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ hackathonId, name: 'Invite Vault Squad', maxCapacity: 4 });
    const teamId = teamRes.body.team.id;

    // Create valid invite -> verify plaintext is NOT stored in DB
    const invRes = await request(app)
      .post(`/api/teams/${teamId}/invites`)
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ expiresInHours: 24, maxUses: 5 });
    expect(invRes.status).toBe(201);
    const rawCode = invRes.body.invite.code as string;
    expect(rawCode.startsWith('cf_')).toBe(true);

    const dbInv = await db.query<{ code_hash: string }>(
      'SELECT code_hash FROM invite_codes WHERE id = $1',
      [invRes.body.invite.id]
    );
    expect(dbInv.rows[0].code_hash).not.toBe(rawCode);
    expect(dbInv.rows[0].code_hash.length).toBe(64);

    // Join using valid code
    const redeemOk = await request(app)
      .post(`/api/teams/${teamId}/join`)
      .set('Authorization', `Bearer ${joiner.token}`)
      .send({ inviteCode: rawCode });
    expect(redeemOk.status).toBe(200);

    // Revoke invite -> subsequent use returns 410
    const revRes = await request(app)
      .delete(`/api/teams/${teamId}/invites/${invRes.body.invite.id}`)
      .set('Authorization', `Bearer ${leader.token}`);
    expect(revRes.status).toBe(200);

    const redeemRevoked = await request(app)
      .post(`/api/teams/${teamId}/join`)
      .set('Authorization', `Bearer ${joiner2.token}`)
      .send({ inviteCode: rawCode });
    expect(redeemRevoked.status).toBe(410);
    expect(redeemRevoked.body.error.code).toBe('INVITE_REVOKED');

    // Create expired invite directly in DB timestamp
    const expInv = await request(app)
      .post(`/api/teams/${teamId}/invites`)
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ expiresInHours: 1, maxUses: 5 });
    await db.query(`UPDATE invite_codes SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [
      expInv.body.invite.id,
    ]);
    const redeemExpired = await request(app)
      .post(`/api/teams/${teamId}/join`)
      .set('Authorization', `Bearer ${joiner2.token}`)
      .send({ inviteCode: expInv.body.invite.code });
    expect(redeemExpired.status).toBe(410);
    expect(redeemExpired.body.error.code).toBe('INVITE_EXPIRED');
  });

  test('19. Idempotency replays original response and rejects payload mismatches with 409', async () => {
    const leader = await createUserAndToken('t19');
    const key = `idem-team-${Date.now()}`;
    const payload = {
      hackathonId,
      name: 'Idempotent Systems',
      description: 'First request',
      maxCapacity: 3,
      requiredSkills: ['TypeScript'],
    };

    const first = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .set('Idempotency-Key', key)
      .send(payload);
    expect(first.status).toBe(201);

    // Replay exact same payload -> returns identical 201 and same team id
    const replay = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .set('Idempotency-Key', key)
      .send(payload);
    expect(replay.status).toBe(201);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(replay.body.team.id).toBe(first.body.team.id);

    // Different payload with same key -> 409
    const mismatch = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .set('Idempotency-Key', key)
      .send({ ...payload, name: 'Different Name' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  test('21. PostgreSQL LISTEN/NOTIFY delivers event only when transaction commits', async () => {
    const received: string[] = [];
    const unlisten = await db.listen(CREWFORGE_CHANNEL, (payload) => {
      received.push(payload);
    });

    const leader = await createUserAndToken('t21');
    await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ hackathonId, name: 'Notify Mesh', maxCapacity: 3 });

    // Give microtask/listener a brief tick to deliver notification
    await new Promise((r) => setTimeout(r, 50));
    await unlisten();

    expect(received.some((raw) => raw.includes('TEAM_CREATED') && raw.includes('Notify Mesh'))).toBe(
      true
    );
  });

  test('22. Deterministic teammate recommendation excludes users already in hackathon teams', async () => {
    const leader = await createUserAndToken('t22l', {
      skills: ['TypeScript'],
      timezone: 'America/Los_Angeles',
    });
    const idealCandidate = await createUserAndToken('t22ideal', {
      skills: ['PostgreSQL', 'Rust'],
      timezone: 'America/Los_Angeles',
    });
    const alreadyTeamed = await createUserAndToken('t22teamed', {
      skills: ['PostgreSQL', 'Rust'],
      timezone: 'America/Los_Angeles',
    });

    const t1 = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({
        hackathonId,
        name: 'Rec Target Team',
        maxCapacity: 4,
        requiredSkills: ['PostgreSQL', 'Rust', 'TypeScript'],
      });
    const t2 = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${alreadyTeamed.token}`)
      .send({
        hackathonId,
        name: 'Rec Rival Team',
        maxCapacity: 4,
      });
    expect(t2.status).toBe(201);

    const recRes = await request(app).get(`/api/teams/${t1.body.team.id}/recommendations`);
    expect(recRes.status).toBe(200);
    const recIds = recRes.body.recommendations.map((r: { userId: string }) => r.userId);
    expect(recIds).toContain(idealCandidate.user.id);
    expect(recIds).not.toContain(alreadyTeamed.user.id);
    expect(recIds).not.toContain(leader.user.id);
  });

  test('23. 50-USER CONCURRENT RACE TEST: 50 simultaneous requests for 1 remaining seat yield exactly 1 winner', async () => {
    // Dedicated hackathon for clean 50-user race verification
    const raceHack = await request(app)
      .post('/api/hackathons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Race Condition Stress Hack', minTeamSize: 1, maxTeamSize: 2 });
    const raceHackId = raceHack.body.hackathon.id as string;

    const leader = await createUserAndToken('race_leader');
    const teamRes = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({
        hackathonId: raceHackId,
        name: 'Last Seat Contention Target',
        maxCapacity: 2, // Leader = 1, exactly 1 seat remaining!
      });
    expect(teamRes.status).toBe(201);
    const targetTeamId = teamRes.body.team.id as string;

    // Create 50 competing users sequentially before firing 50 simultaneous HTTP joins
    const competitors: Array<{ id: string; token: string }> = [];
    for (let i = 1; i <= 50; i++) {
      const c = await createUserAndToken(`racer_${i}`);
      competitors.push({ id: c.user.id, token: c.token });
    }

    // Fire 50 simultaneous independent HTTP join requests concurrently across pg.Pool connections
    const server = await startTestServer(app);
    let responses: Array<{ status: number; code?: string }> = [];
    try {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      responses = await Promise.all(
        competitors.map(async (c) => {
          const res = await fetch(`${baseUrl}/api/teams/${targetTeamId}/join`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${c.token}`,
            },
            body: JSON.stringify({}),
          });
          const body = (await res.json()) as { error?: { code?: string } };
          return { status: res.status, code: body?.error?.code };
        })
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const successes = responses.filter((r) => r.status === 200);
    const capacityRejections = responses.filter(
      (r) => r.status === 409 && r.code === 'TEAM_AT_CAPACITY'
    );
    const serverErrors = responses.filter((r) => r.status >= 500);

    expect(successes.length).toBe(1);
    expect(capacityRejections.length).toBe(49);
    expect(serverErrors.length).toBe(0);

    // Database invariant verification
    const dbTeam = await db.query<{ member_count: number; max_capacity: number }>(
      'SELECT member_count, max_capacity FROM teams WHERE id = $1',
      [targetTeamId]
    );
    expect(dbTeam.rows[0].member_count).toBe(2);
    expect(dbTeam.rows[0].max_capacity).toBe(2);

    const dbMembers = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM team_members WHERE team_id = $1',
      [targetTeamId]
    );
    expect(Number(dbMembers.rows[0].count)).toBe(2);
  });

  test('24. 50 simultaneous retries with same Idempotency-Key create only 1 team and replay identical ID', async () => {
    const leader = await createUserAndToken('t24_concurrent_idem');
    const sharedKey = `concurrent-idem-${Date.now()}`;
    const payload = {
      hackathonId,
      name: 'Concurrent Idempotency Crew',
      description: 'Testing 50 simultaneous duplicate retries',
      maxCapacity: 4,
      requiredSkills: ['PostgreSQL'],
    };

    const server = await startTestServer(app);
    try {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const responses = await Promise.all(
        Array.from({ length: 50 }, async () => {
          const res = await fetch(`${baseUrl}/api/teams`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${leader.token}`,
              'Idempotency-Key': sharedKey,
            },
            body: JSON.stringify(payload),
          });
          return {
            status: res.status,
            replayed: res.headers.get('x-idempotent-replay') === 'true',
            body: (await res.json()) as { team: { id: string } },
          };
        })
      );

      expect(responses.every((r) => r.status === 201)).toBe(true);
      const ids = new Set(responses.map((r) => r.body.team.id));
      expect(ids.size).toBe(1);
      const replays = responses.filter((r) => r.replayed);
      expect(replays.length).toBe(49);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('25. Concurrent duplicate join requests from the same user cannot create duplicate pending rows', async () => {
    const leader = await createUserAndToken('t25l');
    const requester = await createUserAndToken('t25u');

    const teamRes = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ hackathonId, name: 'Concurrent Request Guard', maxCapacity: 4 });
    const targetTeamId = teamRes.body.team.id as string;

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app)
          .post(`/api/teams/${targetTeamId}/join-requests`)
          .set('Authorization', `Bearer ${requester.token}`)
          .send({ message: 'Simultaneous click test' })
      )
    );

    const created = responses.filter((r) => r.status === 201);
    const duplicates = responses.filter(
      (r) => r.status === 409 && r.body?.error?.code === 'DUPLICATE_REQUEST'
    );
    expect(created.length).toBe(1);
    expect(duplicates.length).toBe(9);

    const dbCount = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM join_requests WHERE team_id = $1 AND user_id = $2 AND status = 'pending'`,
      [targetTeamId, requester.user.id]
    );
    expect(Number(dbCount.rows[0].count)).toBe(1);
  });

  test('26. Rolled-back transaction does NOT emit pg_notify SSE events', async () => {
    const leader = await createUserAndToken('t26l');
    const joiner = await createUserAndToken('t26j');

    const teamRes = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ hackathonId, name: 'Rollback Isolation Squad', maxCapacity: 1 });
    // Wait: hackathon minTeamSize is 2, create capacity 2 and fill it first
    expect(teamRes.status).toBe(400);

    const validTeam = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ hackathonId, name: 'Rollback Isolation Valid', maxCapacity: 2 });
    const targetId = validTeam.body.team.id as string;
    await request(app).post(`/api/teams/${targetId}/join`).set('Authorization', `Bearer ${joiner.token}`).send({});

    const received: string[] = [];
    const unlisten = await db.listen(CREWFORGE_CHANNEL, (payload) => {
      received.push(payload);
    });

    // Attempt a doomed join (team at capacity -> rolls back)
    const lateUser = await createUserAndToken('t26late');
    const failedJoin = await request(app)
      .post(`/api/teams/${targetId}/join`)
      .set('Authorization', `Bearer ${lateUser.token}`)
      .send({});
    expect(failedJoin.status).toBe(409);

    // Also run an explicit rolled-back tx with pg_notify inside it
    await expect(
      db.withTransaction(async (tx) => {
        await db.notifyInTx(tx, CREWFORGE_CHANNEL, { type: 'PHANTOM_EVENT', teamId: targetId });
        throw new Error('force_rollback');
      })
    ).rejects.toThrow('force_rollback');

    await new Promise((r) => setTimeout(r, 60));
    await unlisten();

    expect(received.some((raw) => raw.includes('PHANTOM_EVENT'))).toBe(false);
    expect(received.some((raw) => raw.includes(lateUser.user.id))).toBe(false);
  });

  test('27. Case-insensitive team name uniqueness, locked formation guard, and safe discovery query validation', async () => {
    const hackRes = await request(app)
      .post('/api/hackathons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Lockable Hack 2026', minTeamSize: 2, maxTeamSize: 4 });
    const lockHackId = hackRes.body.hackathon.id as string;

    const l1 = await createUserAndToken('t27l1');
    const l2 = await createUserAndToken('t27l2');
    const j1 = await createUserAndToken('t27j1');

    const t1 = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${l1.token}`)
      .send({ hackathonId: lockHackId, name: 'CaseGuard Alpha', maxCapacity: 3 });
    expect(t1.status).toBe(201);

    const dupCase = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${l2.token}`)
      .send({ hackathonId: lockHackId, name: 'caseguard alpha', maxCapacity: 3 });
    expect(dupCase.status).toBe(409);
    expect(dupCase.body.error.code).toBe('DUPLICATE_TEAM_NAME');

    // Lock team formation on hackathon -> joins must fail with 409 TEAM_FORMATION_CLOSED
    const lockRes = await request(app)
      .patch(`/api/hackathons/${lockHackId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ teamFormationStatus: 'locked' });
    expect(lockRes.status).toBe(200);

    const blockedJoin = await request(app)
      .post(`/api/teams/${t1.body.team.id}/join`)
      .set('Authorization', `Bearer ${j1.token}`)
      .send({});
    expect(blockedJoin.status).toBe(409);
    expect(blockedJoin.body.error.code).toBe('TEAM_FORMATION_CLOSED');

    // Discovery query edge cases: non-numeric page/limit fall back safely; bad hackathonId UUID returns 400
    const badPage = await request(app).get('/api/teams?page=abc&limit=xyz');
    expect(badPage.status).toBe(200);
    expect(badPage.body.pagination.page).toBe(1);

    const badUuid = await request(app).get('/api/teams?hackathonId=not-a-uuid');
    expect(badUuid.status).toBe(400);
    expect(badUuid.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('28. Invite brute-force protection throttles excessive invite code attempts with 429', async () => {
    const rateLimitedApp = createApp(db, { enableRateLimit: true });
    const leader = await createUserAndToken('t28l');
    const attacker = await createUserAndToken('t28a');

    const tRes = await request(rateLimitedApp)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ hackathonId, name: 'BruteForce Guard Squad', maxCapacity: 4 });
    expect(tRes.status).toBe(201);
    const targetTeamId = tRes.body.team.id as string;

    const statuses: number[] = [];
    for (let i = 0; i < 17; i++) {
      const res = await request(rateLimitedApp)
        .post(`/api/teams/${targetTeamId}/join`)
        .set('Authorization', `Bearer ${attacker.token}`)
        .send({ inviteCode: `cf_invalid_guess_${i}` });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 15).every((s) => s === 404)).toBe(true);
    expect(statuses[15]).toBe(429);
    expect(statuses[16]).toBe(429);
  });

  test('29. 100-USER CONCURRENT HTTP TEST: 100 simultaneous requests for 5 seats yield exactly 5 winners', async () => {
    const raceHack = await request(app)
      .post('/api/hackathons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '100-User 5-Seat Stress Hack', minTeamSize: 2, maxTeamSize: 6 });
    expect(raceHack.status).toBe(201);
    const raceHackId = raceHack.body.hackathon.id as string;

    const leader = await createUserAndToken('t29_leader');
    const teamRes = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({
        hackathonId: raceHackId,
        name: 'Five Seat Contention Target',
        maxCapacity: 6, // Leader = 1, 5 seats open
      });
    expect(teamRes.status).toBe(201);
    const targetTeamId = teamRes.body.team.id as string;

    const competitors: Array<{ id: string; token: string }> = [];
    for (let i = 1; i <= 100; i++) {
      const c = await createUserAndToken(`racer100_${i}`);
      competitors.push({ id: c.user.id, token: c.token });
    }

    const server = await startTestServer(app);
    try {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const responses = await Promise.all(
        competitors.map(async (c) => {
          const res = await fetch(`${baseUrl}/api/teams/${targetTeamId}/join`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${c.token}`,
            },
            body: JSON.stringify({}),
          });
          const body = (await res.json()) as { error?: { code?: string } };
          return { status: res.status, code: body?.error?.code };
        })
      );

      const successes = responses.filter((r) => r.status === 200);
      const capacityRejections = responses.filter(
        (r) => r.status === 409 && r.code === 'TEAM_AT_CAPACITY'
      );
      const serverErrors = responses.filter((r) => r.status >= 500);

      expect(successes.length).toBe(5);
      expect(capacityRejections.length).toBe(95);
      expect(serverErrors.length).toBe(0);

      const dbTeam = await db.query<{ member_count: number; max_capacity: number }>(
        'SELECT member_count, max_capacity FROM teams WHERE id = $1',
        [targetTeamId]
      );
      expect(dbTeam.rows[0].member_count).toBe(6);
      expect(dbTeam.rows[0].max_capacity).toBe(6);

      const dbMembers = await db.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM team_members WHERE team_id = $1',
        [targetTeamId]
      );
      expect(Number(dbMembers.rows[0].count)).toBe(6);

      const dupes = await db.query<{ dupes: string }>(
        `SELECT COUNT(*)::text AS dupes FROM (
           SELECT hackathon_id, user_id FROM team_members
           WHERE hackathon_id = $1 GROUP BY hackathon_id, user_id HAVING COUNT(*) > 1
         ) d`,
        [raceHackId]
      );
      expect(Number(dupes.rows[0].dupes)).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('30. 50 simultaneous join retries with the same Idempotency-Key create 1 membership and replay 49 times', async () => {
    const leader = await createUserAndToken('t30_leader');
    const joiner = await createUserAndToken('t30_joiner');

    const teamRes = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${leader.token}`)
      .send({ hackathonId, name: 'Join Idempotency Burst Squad', maxCapacity: 4 });
    expect(teamRes.status).toBe(201);
    const targetTeamId = teamRes.body.team.id as string;
    const sharedKey = `join-idem-50-${Date.now()}`;

    const server = await startTestServer(app);
    try {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const responses = await Promise.all(
        Array.from({ length: 50 }, async () => {
          const res = await fetch(`${baseUrl}/api/teams/${targetTeamId}/join`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${joiner.token}`,
              'Idempotency-Key': sharedKey,
            },
            body: JSON.stringify({}),
          });
          return {
            status: res.status,
            replayed: res.headers.get('x-idempotent-replay') === 'true',
            body: (await res.json()) as { membershipId: string },
          };
        })
      );

      expect(responses.every((r) => r.status === 200)).toBe(true);
      const membershipIds = new Set(responses.map((r) => r.body.membershipId));
      expect(membershipIds.size).toBe(1);
      expect(responses.filter((r) => r.replayed).length).toBe(49);

      const dbTeam = await db.query<{ member_count: number }>(
        'SELECT member_count FROM teams WHERE id = $1',
        [targetTeamId]
      );
      expect(dbTeam.rows[0].member_count).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
