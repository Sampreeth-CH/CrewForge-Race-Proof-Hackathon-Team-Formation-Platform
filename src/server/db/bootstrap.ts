import bcrypt from 'bcryptjs';
import { DatabaseManager } from './client.ts';
import { runMigrations } from './migrate.ts';

export async function seedBaselineIfEmpty(db: DatabaseManager): Promise<void> {
  const hackCount = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM hackathons');
  if (Number(hackCount.rows[0].count) > 0) {
    return;
  }

  const demoPasswordHash = await bcrypt.hash('CrewForgeDemo!2026', 10);

  await db.withTransaction(async (tx) => {
    // 1. Core demo users (Participant, Organizer, Admin)
    const usersData = [
      {
        fullName: 'Maya Lin',
        email: 'maya@crewforge.dev',
        role: 'participant',
        bio: 'Distributed systems & PostgreSQL engineer focusing on high-throughput transactional pipelines.',
        skills: ['PostgreSQL', 'TypeScript', 'Node.js', 'Go', 'Docker'],
        experienceLevel: 'advanced',
        timezone: 'America/Los_Angeles',
      },
      {
        fullName: 'Arjun Mehta',
        email: 'arjun@crewforge.dev',
        role: 'organizer',
        bio: 'Hack4Hack organizer and systems architect managing multi-track concurrency challenges.',
        skills: ['Architecture', 'Kubernetes', 'PostgreSQL', 'Python'],
        experienceLevel: 'staff',
        timezone: 'America/New_York',
      },
      {
        fullName: 'Elena Rostova',
        email: 'elena@crewforge.dev',
        role: 'admin',
        bio: 'Platform reliability lead and RaceLab administrator.',
        skills: ['PostgreSQL', 'Rust', 'Terraform', 'Security'],
        experienceLevel: 'staff',
        timezone: 'Europe/Berlin',
      },
      {
        fullName: 'Liam OConnor',
        email: 'liam@crewforge.dev',
        role: 'participant',
        bio: 'Frontend systems engineer crafting accessible, high-density operational dashboards.',
        skills: ['React', 'TypeScript', 'Tailwind CSS', 'Vite'],
        experienceLevel: 'advanced',
        timezone: 'Europe/London',
      },
      {
        fullName: 'Sofia Alvarez',
        email: 'sofia@crewforge.dev',
        role: 'participant',
        bio: 'Applied ML & backend engineer focused on deterministic ranking and vector indexing.',
        skills: ['Python', 'PostgreSQL', 'FastAPI', 'PyTorch'],
        experienceLevel: 'intermediate',
        timezone: 'America/Chicago',
      },
      {
        fullName: 'Kenji Sato',
        email: 'kenji@crewforge.dev',
        role: 'participant',
        bio: 'Security engineer specializing in cryptographic protocols and zero-trust APIs.',
        skills: ['Rust', 'Security', 'OAuth', 'TypeScript'],
        experienceLevel: 'advanced',
        timezone: 'Asia/Tokyo',
      },
      {
        fullName: 'Priya Nair',
        email: 'priya@crewforge.dev',
        role: 'participant',
        bio: 'Full-stack TypeScript engineer passionate about real-time streaming and SSE.',
        skills: ['TypeScript', 'React', 'PostgreSQL', 'Redis'],
        experienceLevel: 'intermediate',
        timezone: 'America/Los_Angeles',
      },
      {
        fullName: 'Noah Brooks',
        email: 'noah@crewforge.dev',
        role: 'participant',
        bio: 'Site reliability & k6 performance testing specialist.',
        skills: ['Go', 'k6', 'Prometheus', 'PostgreSQL'],
        experienceLevel: 'advanced',
        timezone: 'America/New_York',
      },
    ];

    const userIds: Record<string, string> = {};
    for (const u of usersData) {
      const res = await tx.query<{ id: string }>(
        `INSERT INTO users (full_name, email, password_hash, role, bio, skills, experience_level, timezone)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8)
         ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING id`,
        [u.fullName, u.email, demoPasswordHash, u.role, u.bio, u.skills, u.experienceLevel, u.timezone]
      );
      userIds[u.email] = res.rows[0].id;
    }

    // 2. Hackathons (2 active public hackathons + 1 isolated RaceLab sandbox)
    const hack1 = await tx.query<{ id: string }>(
      `INSERT INTO hackathons (slug, name, description, registration_status, team_formation_status, min_team_size, max_team_size, is_demo_sandbox)
       VALUES ($1, $2, $3, 'open', 'open', 2, 4, FALSE)
       RETURNING id`,
      [
        'hack4hack-2026',
        'Hack4Hack Crew Challenge 2026',
        'Flagship distributed systems and concurrency engineering hackathon featuring live load verification.',
      ]
    );
    const hack2 = await tx.query<{ id: string }>(
      `INSERT INTO hackathons (slug, name, description, registration_status, team_formation_status, min_team_size, max_team_size, is_demo_sandbox)
       VALUES ($1, $2, $3, 'open', 'open', 2, 5, FALSE)
       RETURNING id`,
      [
        'cloud-native-sprint',
        'Cloud Native Systems Sprint',
        '48-hour build sprint for resilient PostgreSQL, Kubernetes, and real-time telemetry tooling.',
      ]
    );
    const sandboxHack = await tx.query<{ id: string }>(
      `INSERT INTO hackathons (slug, name, description, registration_status, team_formation_status, min_team_size, max_team_size, is_demo_sandbox)
       VALUES ($1, $2, $3, 'open', 'open', 1, 10, TRUE)
       RETURNING id`,
      [
        'racelab-sandbox',
        'RaceLab Isolated Verification Sandbox',
        'Dedicated sandbox environment for executing live 50-user simultaneous seat contention experiments safely.',
      ]
    );

    const h1 = hack1.rows[0].id;
    const h2 = hack2.rows[0].id;
    const hSandbox = sandboxHack.rows[0].id;

    // 3. Initial sample teams across both active hackathons
    const teamSpecs = [
      {
        hackathonId: h1,
        name: 'LockSmith Core',
        description: 'Building deterministic row-lock orchestration and real-time SSE contention telemetry.',
        leaderEmail: 'maya@crewforge.dev',
        memberEmails: ['maya@crewforge.dev', 'liam@crewforge.dev'],
        maxCapacity: 4,
        requiredSkills: ['PostgreSQL', 'TypeScript', 'React', 'Go'],
        status: 'ready',
      },
      {
        hackathonId: h1,
        name: 'Atomic Quorum',
        description: 'Zero-trust invitation cryptographic vault and idempotent gateway proxy.',
        leaderEmail: 'kenji@crewforge.dev',
        memberEmails: ['kenji@crewforge.dev'],
        maxCapacity: 4,
        requiredSkills: ['Rust', 'Security', 'PostgreSQL', 'React'],
        status: 'forming',
      },
      {
        hackathonId: h1,
        name: 'Latency Zero',
        description: 'Pushing p95 team board discovery queries below 25ms with GIN & covering indexes.',
        leaderEmail: 'noah@crewforge.dev',
        memberEmails: ['noah@crewforge.dev', 'sofia@crewforge.dev'],
        maxCapacity: 3,
        requiredSkills: ['PostgreSQL', 'Go', 'k6', 'TypeScript'],
        status: 'ready',
      },
      {
        hackathonId: h2,
        name: 'PgNotify Mesh',
        description: 'Transactional event-driven synchronization across multi-region Cloud Run replicas.',
        leaderEmail: 'arjun@crewforge.dev',
        memberEmails: ['arjun@crewforge.dev'],
        maxCapacity: 5,
        requiredSkills: ['PostgreSQL', 'Kubernetes', 'TypeScript', 'React'],
        status: 'forming',
      },
    ];

    for (const spec of teamSpecs) {
      const leaderId = userIds[spec.leaderEmail];
      const teamInsert = await tx.query<{ id: string }>(
        `INSERT INTO teams (hackathon_id, name, description, leader_id, member_count, max_capacity, required_skills, status, is_demo_sandbox)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, FALSE)
         RETURNING id`,
        [
          spec.hackathonId,
          spec.name,
          spec.description,
          leaderId,
          spec.memberEmails.length,
          spec.maxCapacity,
          spec.requiredSkills,
          spec.status,
        ]
      );
      const teamId = teamInsert.rows[0].id;

      for (const email of spec.memberEmails) {
        await tx.query(
          `INSERT INTO team_members (team_id, hackathon_id, user_id, role)
           VALUES ($1, $2, $3, $4)`,
          [teamId, spec.hackathonId, userIds[email], email === spec.leaderEmail ? 'leader' : 'member']
        );
      }

      await tx.query(
        `INSERT INTO audit_logs (actor_id, team_id, hackathon_id, action, target_user_id, metadata)
         VALUES ($1, $2, $3, 'TEAM_CREATED', $1, $4::jsonb)`,
        [
          leaderId,
          teamId,
          spec.hackathonId,
          JSON.stringify({ name: spec.name, maxCapacity: spec.maxCapacity, seeded: true }),
        ]
      );
    }

    // 4. Seed 1 default RaceLab demo team in the isolated sandbox
    const adminId = userIds['elena@crewforge.dev'];
    const sandboxTeam = await tx.query<{ id: string }>(
      `INSERT INTO teams (hackathon_id, name, description, leader_id, member_count, max_capacity, required_skills, status, is_demo_sandbox)
       VALUES ($1, $2, $3, $4, 1, 2, $5::text[], 'forming', TRUE)
       RETURNING id`,
      [
        hSandbox,
        'Last-Seat Contention Target #01',
        'Isolated sandbox team configured with 1 open seat for live 50-request concurrency testing.',
        adminId,
        ['PostgreSQL', 'Concurrency', 'SELECT FOR UPDATE'],
      ]
    );
    await tx.query(
      `INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES ($1, $2, $3, 'leader')`,
      [sandboxTeam.rows[0].id, hSandbox, adminId]
    );
  });
}

export async function initializeDatabase(db: DatabaseManager): Promise<void> {
  await runMigrations(db);
  await seedBaselineIfEmpty(db);
}
