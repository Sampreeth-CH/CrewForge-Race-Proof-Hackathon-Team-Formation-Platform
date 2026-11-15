import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { getDb } from '../src/server/db/client.ts';
import { initializeDatabase } from '../src/server/db/bootstrap.ts';

const SKILLS_POOL = [
  'PostgreSQL',
  'TypeScript',
  'React',
  'Node.js',
  'Go',
  'Rust',
  'Python',
  'Kubernetes',
  'Docker',
  'GraphQL',
  'Redis',
  'Security',
  'Tailwind CSS',
  'k6',
];

const TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

const EXP_LEVELS = ['beginner', 'intermediate', 'advanced', 'staff'] as const;

function deterministicSkills(seed: number): string[] {
  const count = 2 + (seed % 3);
  const picked = new Set<string>();
  for (let i = 0; i < count; i++) {
    picked.add(SKILLS_POOL[(seed * 7 + i * 3) % SKILLS_POOL.length]);
  }
  return Array.from(picked);
}

export async function runLargeScaleSeed() {
  const db = getDb();
  await initializeDatabase(db);

  const existingCheck = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM users WHERE email LIKE 'seed-user-%@crewforge.dev'`
  );
  if (Number(existingCheck.rows[0].count) >= 10000) {
    console.log('Seed dataset already present (10,000+ seeded users). Skipping.');
    return { usersInserted: 0, teamsInserted: 0, membershipsInserted: 0 };
  }

  console.log('Starting deterministic 10,000-user / 2,000-team idempotent seed...');
  const startedAt = Date.now();
  const sharedHash = await bcrypt.hash('SeedUser!2026', 6);

  // Ensure 4 public hackathons exist for distributing 2,000 teams
  const hackDefs = [
    { slug: 'hack4hack-2026', name: 'Hack4Hack Crew Challenge 2026', min: 2, max: 4 },
    { slug: 'cloud-native-sprint', name: 'Cloud Native Systems Sprint', min: 2, max: 5 },
    { slug: 'distributed-db-jam', name: 'Distributed Database Systems Jam', min: 2, max: 4 },
    { slug: 'zero-trust-build', name: 'Zero-Trust Security Buildathon', min: 2, max: 5 },
  ];

  const hackathonIds: string[] = [];
  for (const h of hackDefs) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO hackathons (slug, name, description, registration_status, team_formation_status, min_team_size, max_team_size, is_demo_sandbox)
       VALUES ($1, $2, $3, 'open', 'open', $4, $5, FALSE)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [h.slug, h.name, `${h.name} — large-scale concurrency track`, h.min, h.max]
    );
    hackathonIds.push(res.rows[0].id);
  }

  // Batch insert 10,000 users in chunks of 1,000
  const TOTAL_USERS = 10000;
  const BATCH_SIZE = 1000;

  for (let start = 1; start <= TOTAL_USERS; start += BATCH_SIZE) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    const end = Math.min(TOTAL_USERS, start + BATCH_SIZE - 1);

    for (let i = start; i <= end; i++) {
      const idx = values.length;
      const email = `seed-user-${String(i).padStart(5, '0')}@crewforge.dev`;
      const fullName = `Engineer ${String(i).padStart(5, '0')}`;
      const skills = deterministicSkills(i);
      const exp = EXP_LEVELS[i % EXP_LEVELS.length];
      const tz = TIMEZONES[i % TIMEZONES.length];

      values.push(fullName, email, sharedHash, skills, exp, tz);
      placeholders.push(
        `($${idx + 1}, $${idx + 2}, $${idx + 3}, 'participant', 'Seeded hackathon builder.', $${idx + 4}::text[], $${idx + 5}, $${idx + 6})`
      );
    }

    await db.query(
      `INSERT INTO users (full_name, email, password_hash, role, bio, skills, experience_level, timezone)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (email) DO NOTHING`,
      values
    );
  }

  // Load seeded user IDs deterministically ordered by email
  const seededUsersRes = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE 'seed-user-%@crewforge.dev' ORDER BY email ASC`
  );
  const userIds = seededUsersRes.rows.map((r) => r.id);

  // Create 2,000 teams across the 4 hackathons (500 teams per hackathon)
  // Each team uses distinct users within its hackathon so UNIQUE (hackathon_id, user_id) is strictly respected.
  const TOTAL_TEAMS = 2000;
  let teamsInserted = 0;
  let membershipsInserted = 0;

  for (let batchStart = 0; batchStart < TOTAL_TEAMS; batchStart += 200) {
    await db.withTransaction(async (tx) => {
      const batchEnd = Math.min(TOTAL_TEAMS, batchStart + 200);
      for (let tIdx = batchStart; tIdx < batchEnd; tIdx++) {
        const hackIdx = tIdx % hackathonIds.length;
        const hackId = hackathonIds[hackIdx];
        const maxCap = hackDefs[hackIdx].max;

        // Realistic member distribution: 1..maxCap, leaving ~65% of teams looking for members
        const targetMembers = (tIdx % 4 === 0) ? maxCap : 1 + (tIdx % Math.max(1, maxCap - 1));
        const teamName = `ScaleTeam-${String(tIdx + 1).padStart(4, '0')}`;

        // Assign non-overlapping user slice per hackathon (500 teams * 5 max = 2,500 users per hackathon <= 10,000 users!)
        const localTeamNum = Math.floor(tIdx / hackathonIds.length);
        const baseUserOffset = (hackIdx * 2500 + localTeamNum * 5) % userIds.length;
        const leaderId = userIds[baseUserOffset];

        const status = targetMembers >= hackDefs[hackIdx].min ? 'ready' : 'forming';
        const reqSkills = deterministicSkills(tIdx + 17);

        const insertedTeam = await tx.query<{ id: string }>(
          `INSERT INTO teams (hackathon_id, name, description, leader_id, member_count, max_capacity, required_skills, status, is_demo_sandbox)
           VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, FALSE)
           ON CONFLICT (hackathon_id, name) DO NOTHING
           RETURNING id`,
          [
            hackId,
            teamName,
            `Seeded distributed engineering crew #${tIdx + 1} (${targetMembers}/${maxCap} seats filled).`,
            leaderId,
            targetMembers,
            maxCap,
            reqSkills,
            status,
          ]
        );

        if (insertedTeam.rows.length === 0) continue;
        const teamId = insertedTeam.rows[0].id;
        teamsInserted++;

        for (let m = 0; m < targetMembers; m++) {
          const memberUserId = userIds[(baseUserOffset + m) % userIds.length];
          await tx.query(
            `INSERT INTO team_members (team_id, hackathon_id, user_id, role)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [teamId, hackId, memberUserId, m === 0 ? 'leader' : 'member']
          );
          membershipsInserted++;
        }
      }
    });
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `Seed complete in ${durationMs}ms: ${userIds.length} users, ${teamsInserted} teams, ${membershipsInserted} memberships.`
  );
  return { usersInserted: userIds.length, teamsInserted, membershipsInserted };
}

if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  runLargeScaleSeed()
    .then(async () => {
      await getDb().close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Seed failed:', err);
      await getDb().close();
      process.exit(1);
    });
}
