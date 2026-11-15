import crypto from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

async function verifyFirebaseIdToken(idToken: string) {
  const { initializeApp, getApps } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  if (!getApps().length && firebaseConfig?.projectId) {
    initializeApp({ projectId: firebaseConfig.projectId });
  }
  return getAuth().verifyIdToken(idToken);
}

import { DatabaseManager, getDb } from './db/client.ts';
import { AppError, isPgError } from './errors.ts';
import {
  AuthRequest,
  clearSessionCookie,
  createAuthMiddleware,
  setSessionCookie,
  signSessionToken,
} from './middleware/auth.ts';
import { executeIdempotent } from './services/idempotency.ts';
import {
  acceptJoinRequestInTx,
  createJoinRequestInTx,
  createTeamInTx,
  deleteTeamInTx,
  directJoinTeamInTx,
  leaveTeamInTx,
  rejectJoinRequestInTx,
  removeMemberInTx,
  transferLeadershipInTx,
  updateTeamInTx,
} from './services/membership.ts';
import { createTeamInvite, revokeTeamInvite } from './services/invites.ts';
import { insertAuditLog } from './services/audit.ts';
import { sseHub } from './services/sse.ts';
import { rankTeammateCandidates } from '../shared/logic.ts';

const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
  bio: z.string().trim().max(600).optional().default(''),
  skills: z.array(z.string().trim().min(1).max(40)).max(20).optional().default([]),
  experienceLevel: z
    .enum(['beginner', 'intermediate', 'advanced', 'staff'])
    .optional()
    .default('intermediate'),
  timezone: z.string().trim().min(1).max(64).optional().default('UTC'),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const updateProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  bio: z.string().trim().max(600).optional(),
  skills: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  experienceLevel: z.enum(['beginner', 'intermediate', 'advanced', 'staff']).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

const createHackathonSchema = z
  .object({
    name: z.string().trim().min(3).max(140),
    slug: z
      .string()
      .trim()
      .min(3)
      .max(80)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    description: z.string().trim().max(1000).optional().default(''),
    minTeamSize: z.number().int().min(1).max(10).default(2),
    maxTeamSize: z.number().int().min(1).max(20).default(4),
    registrationStatus: z.enum(['draft', 'open', 'closed']).optional().default('open'),
    teamFormationStatus: z.enum(['open', 'locked', 'closed']).optional().default('open'),
  })
  .refine((d) => d.maxTeamSize >= d.minTeamSize, {
    message: 'maxTeamSize must be greater than or equal to minTeamSize',
  });

const createTeamSchema = z.object({
  hackathonId: z.string().uuid(),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).optional().default(''),
  maxCapacity: z.number().int().min(1).max(20).optional(),
  requiredSkills: z.array(z.string().trim().min(1).max(40)).max(15).optional().default([]),
});

const updateTeamSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  maxCapacity: z.number().int().min(1).max(20).optional(),
  requiredSkills: z.array(z.string().trim().min(1).max(40)).max(15).optional(),
  status: z.enum(['forming', 'ready', 'locked']).optional(),
});

const joinTeamSchema = z.object({
  inviteCode: z.string().trim().min(1).max(200).optional(),
});

const joinRequestSchema = z.object({
  message: z.string().trim().max(500).optional().default(''),
});

const createInviteSchema = z.object({
  expiresInHours: z.number().min(0.01).max(720).optional().default(72),
  maxUses: z.number().int().min(1).max(100).optional().default(10),
});

const raceLabSetupSchema = z.object({
  hackathonId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  availableSeats: z.number().int().min(1).max(5).default(1),
  competitorCount: z.number().int().min(2).max(60).default(50),
});

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

function serializeUser(row: {
  id: string;
  full_name: string;
  email: string;
  role: string;
  bio: string;
  skills: string[];
  experience_level: string;
  timezone: string;
  created_at: string;
}) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    bio: row.bio,
    skills: row.skills,
    experienceLevel: row.experience_level,
    timezone: row.timezone,
    createdAt: row.created_at,
  };
}

export function createApp(db: DatabaseManager = getDb(), options?: { enableRateLimit?: boolean }) {
  const app = express();
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );

  const rawOrigins = (process.env.CORS_ORIGIN || process.env.APP_URL || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const isProd = process.env.NODE_ENV === 'production';
  const allowedOrigins = isProd
    ? rawOrigins
    : Array.from(new Set([...rawOrigins, 'http://localhost:3000', 'http://127.0.0.1:3000']));

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.length === 0) return callback(null, !isProd);
        const normalized = origin.replace(/\/$/, '');
        if (allowedOrigins.includes(normalized)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const { requireAuth, optionalAuth, requireRole } = createAuthMiddleware(db);

  const authLimiter =
    options?.enableRateLimit === false
      ? (_req: Request, _res: Response, next: NextFunction) => next()
      : rateLimit({
          windowMs: 60 * 1000,
          max: 60,
          standardHeaders: true,
          legacyHeaders: false,
          message: { error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts.' } },
        });

  const joinLimiter =
    options?.enableRateLimit === false
      ? (_req: Request, _res: Response, next: NextFunction) => next()
      : rateLimit({
          windowMs: 60 * 1000,
          max: 240,
          standardHeaders: true,
          legacyHeaders: false,
          message: { error: { code: 'RATE_LIMITED', message: 'Too many join attempts.' } },
        });

  const inviteBruteForceLimiter =
    options?.enableRateLimit === false
      ? (_req: Request, _res: Response, next: NextFunction) => next()
      : rateLimit({
          windowMs: 60 * 1000,
          max: 15,
          skip: (req) => !(typeof req.body?.inviteCode === 'string' && req.body.inviteCode.trim().length > 0),
          standardHeaders: true,
          legacyHeaders: false,
          message: {
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many invitation code redemption attempts. Try again in one minute.',
            },
          },
        });

  const asyncHandler =
    (fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<unknown>) =>
    (req: AuthRequest, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };

  // Health Endpoint
  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      const result = await db.query<{ ok: number }>('SELECT 1 AS ok');
      res.json({
        status: 'ok',
        dbEngine: db.mode === 'pg-pool' ? 'postgresql' : 'pglite-postgres',
        dbReady: result.rows[0]?.ok === 1,
        sseClients: sseHub.getClientCount(),
        timestamp: new Date().toISOString(),
      });
    })
  );

  // Realtime SSE stream backed by PostgreSQL LISTEN/NOTIFY
  app.get('/api/events/stream', (req, res) => {
    sseHub.subscribe(req, res);
  });

  // --- AUTHENTICATION ---
  app.post(
    '/api/auth/register',
    authLimiter,
    asyncHandler(async (req, res) => {
      const parsed = registerSchema.parse(req.body);
      const emailLower = parsed.email.toLowerCase();
      const passwordHash = await bcrypt.hash(parsed.password, 10);

      try {
        const result = await db.query<{
          id: string;
          full_name: string;
          email: string;
          role: string;
          bio: string;
          skills: string[];
          experience_level: string;
          timezone: string;
          created_at: string;
        }>(
          `INSERT INTO users (full_name, email, password_hash, role, bio, skills, experience_level, timezone)
           VALUES ($1, $2, $3, 'participant', $4, $5::text[], $6, $7)
           RETURNING id, full_name, email, role, bio, skills, experience_level, timezone, created_at`,
          [
            parsed.fullName,
            emailLower,
            passwordHash,
            parsed.bio,
            parsed.skills,
            parsed.experienceLevel,
            parsed.timezone,
          ]
        );

        const user = result.rows[0];
        const token = signSessionToken(user);
        setSessionCookie(res, token);
        res.status(201).json({ user: serializeUser(user), token });
      } catch (err) {
        if (isPgError(err) && err.code === '23505') {
          throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists.');
        }
        throw err;
      }
    })
  );

  app.post(
    '/api/auth/login',
    authLimiter,
    asyncHandler(async (req, res) => {
      const parsed = loginSchema.parse(req.body);
      const emailLower = parsed.email.toLowerCase();

      const result = await db.query<{
        id: string;
        full_name: string;
        email: string;
        password_hash: string;
        role: string;
        bio: string;
        skills: string[];
        experience_level: string;
        timezone: string;
        created_at: string;
      }>('SELECT * FROM users WHERE email = $1', [emailLower]);

      if (result.rows.length === 0) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
      }
      const user = result.rows[0];
      const valid = await bcrypt.compare(parsed.password, user.password_hash);
      if (!valid) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
      }

      const token = signSessionToken(user);
      setSessionCookie(res, token);
      res.json({ user: serializeUser(user), token });
    })
  );

  app.post(
    '/api/auth/firebase',
    authLimiter,
    asyncHandler(async (req, res) => {
      const { idToken } = z.object({ idToken: z.string().min(10) }).parse(req.body);
      let decoded;
      try {
        decoded = await verifyFirebaseIdToken(idToken);
      } catch {
        throw new AppError(401, 'INVALID_FIREBASE_TOKEN', 'Invalid Firebase ID token.');
      }

      const email = (decoded.email || `${decoded.uid}@firebase.crewforge.dev`).toLowerCase();
      const fullName = decoded.name || email.split('@')[0];
      const unusablePasswordPlaceholder = `!firebase!${crypto.randomBytes(24).toString('hex')}`;

      const upsert = await db.query<{
        id: string;
        full_name: string;
        email: string;
        role: string;
        bio: string;
        skills: string[];
        experience_level: string;
        timezone: string;
        created_at: string;
      }>(
        `INSERT INTO users (firebase_uid, full_name, email, password_hash, role, timezone)
         VALUES ($1, $2, $3, $4, 'participant', 'UTC')
         ON CONFLICT (email) DO UPDATE SET firebase_uid = EXCLUDED.firebase_uid, updated_at = NOW()
         RETURNING id, full_name, email, role, bio, skills, experience_level, timezone, created_at`,
        [decoded.uid, fullName, email, unusablePasswordPlaceholder]
      );

      const user = upsert.rows[0];
      const token = signSessionToken(user);
      setSessionCookie(res, token);
      res.json({ user: serializeUser(user), token });
    })
  );

  app.post('/api/auth/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get(
    '/api/auth/session',
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) {
        return res.json({ user: null, memberships: [] });
      }
      const result = await db.query<{
        id: string;
        full_name: string;
        email: string;
        role: string;
        bio: string;
        skills: string[];
        experience_level: string;
        timezone: string;
        created_at: string;
      }>(
        `SELECT id, full_name, email, role, bio, skills, experience_level, timezone, created_at
         FROM users WHERE id = $1`,
        [req.user.id]
      );
      if (result.rows.length === 0) {
        return res.json({ user: null, memberships: [] });
      }

      const memberships = await db.query<{
        team_id: string;
        team_name: string;
        hackathon_id: string;
        hackathon_name: string;
        role: string;
      }>(
        `SELECT tm.team_id, t.name AS team_name, tm.hackathon_id, h.name AS hackathon_name, tm.role
         FROM team_members tm
         JOIN teams t ON t.id = tm.team_id
         JOIN hackathons h ON h.id = tm.hackathon_id
         WHERE tm.user_id = $1 AND t.is_demo_sandbox = FALSE`,
        [req.user.id]
      );

      res.json({
        user: serializeUser(result.rows[0]),
        memberships: memberships.rows.map((m) => ({
          teamId: m.team_id,
          teamName: m.team_name,
          hackathonId: m.hackathon_id,
          hackathonName: m.hackathon_name,
          role: m.role,
        })),
      });
    })
  );

  app.get(
    '/api/auth/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const result = await db.query<{
        id: string;
        full_name: string;
        email: string;
        role: string;
        bio: string;
        skills: string[];
        experience_level: string;
        timezone: string;
        created_at: string;
      }>(
        `SELECT id, full_name, email, role, bio, skills, experience_level, timezone, created_at
         FROM users WHERE id = $1`,
        [req.user!.id]
      );
      if (result.rows.length === 0) {
        throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
      }

      const memberships = await db.query<{
        team_id: string;
        team_name: string;
        hackathon_id: string;
        hackathon_name: string;
        role: string;
      }>(
        `SELECT tm.team_id, t.name AS team_name, tm.hackathon_id, h.name AS hackathon_name, tm.role
         FROM team_members tm
         JOIN teams t ON t.id = tm.team_id
         JOIN hackathons h ON h.id = tm.hackathon_id
         WHERE tm.user_id = $1 AND t.is_demo_sandbox = FALSE`,
        [req.user!.id]
      );

      res.json({
        user: serializeUser(result.rows[0]),
        memberships: memberships.rows.map((m) => ({
          teamId: m.team_id,
          teamName: m.team_name,
          hackathonId: m.hackathon_id,
          hackathonName: m.hackathon_name,
          role: m.role,
        })),
      });
    })
  );

  app.patch(
    '/api/auth/profile',
    requireAuth,
    asyncHandler(async (req, res) => {
      const parsed = updateProfileSchema.parse(req.body);
      const currentRes = await db.query<{
        full_name: string;
        bio: string;
        skills: string[];
        experience_level: string;
        timezone: string;
      }>('SELECT full_name, bio, skills, experience_level, timezone FROM users WHERE id = $1', [
        req.user!.id,
      ]);
      if (currentRes.rows.length === 0) {
        throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
      }
      const current = currentRes.rows[0];
      const updated = await db.query<{
        id: string;
        full_name: string;
        email: string;
        role: string;
        bio: string;
        skills: string[];
        experience_level: string;
        timezone: string;
        created_at: string;
      }>(
        `UPDATE users
         SET full_name = $2,
             bio = $3,
             skills = $4::text[],
             experience_level = $5,
             timezone = $6,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, full_name, email, role, bio, skills, experience_level, timezone, created_at`,
        [
          req.user!.id,
          parsed.fullName ?? current.full_name,
          parsed.bio ?? current.bio,
          parsed.skills ?? current.skills,
          parsed.experienceLevel ?? current.experience_level,
          parsed.timezone ?? current.timezone,
        ]
      );
      res.json({ user: serializeUser(updated.rows[0]) });
    })
  );

  // --- HACKATHONS ---
  app.get(
    '/api/hackathons',
    asyncHandler(async (req, res) => {
      const includeSandbox = req.query.includeSandbox === 'true';
      const rows = await db.query<{
        id: string;
        slug: string;
        name: string;
        description: string;
        registration_status: string;
        team_formation_status: string;
        min_team_size: number;
        max_team_size: number;
        is_demo_sandbox: boolean;
        created_at: string;
        team_count: string;
        participant_count: string;
      }>(
        `SELECT h.*,
                (SELECT COUNT(*) FROM teams t WHERE t.hackathon_id = h.id)::text AS team_count,
                (SELECT COUNT(*) FROM team_members tm WHERE tm.hackathon_id = h.id)::text AS participant_count
         FROM hackathons h
         ${includeSandbox ? '' : 'WHERE h.is_demo_sandbox = FALSE'}
         ORDER BY h.is_demo_sandbox ASC, h.created_at DESC`
      );

      res.json({
        hackathons: rows.rows.map((h) => ({
          id: h.id,
          slug: h.slug,
          name: h.name,
          description: h.description,
          registrationStatus: h.registration_status,
          teamFormationStatus: h.team_formation_status,
          minTeamSize: h.min_team_size,
          maxTeamSize: h.max_team_size,
          isDemoSandbox: h.is_demo_sandbox,
          teamCount: Number(h.team_count),
          participantCount: Number(h.participant_count),
          createdAt: h.created_at,
        })),
      });
    })
  );

  app.post(
    '/api/hackathons',
    requireAuth,
    requireRole(['organizer', 'admin']),
    asyncHandler(async (req, res) => {
      const parsed = createHackathonSchema.parse(req.body);
      const slug =
        parsed.slug ||
        `${parsed.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')}-${Date.now().toString(36)}`;

      const idempKey = req.header('Idempotency-Key');
      const result = await executeIdempotent(db, {
        scopeKey: `${req.user!.id}:POST:/api/hackathons`,
        idempotencyKey: idempKey,
        payload: parsed,
        run: async (tx) => {
          const inserted = await tx.query<{
            id: string;
            slug: string;
            name: string;
            description: string;
            registration_status: string;
            team_formation_status: string;
            min_team_size: number;
            max_team_size: number;
            is_demo_sandbox: boolean;
            created_at: string;
          }>(
            `INSERT INTO hackathons (slug, name, description, registration_status, team_formation_status, min_team_size, max_team_size)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
              slug,
              parsed.name,
              parsed.description,
              parsed.registrationStatus,
              parsed.teamFormationStatus,
              parsed.minTeamSize,
              parsed.maxTeamSize,
            ]
          );
          const h = inserted.rows[0];
          return {
            statusCode: 201,
            body: {
              hackathon: {
                id: h.id,
                slug: h.slug,
                name: h.name,
                description: h.description,
                registrationStatus: h.registration_status,
                teamFormationStatus: h.team_formation_status,
                minTeamSize: h.min_team_size,
                maxTeamSize: h.max_team_size,
                isDemoSandbox: h.is_demo_sandbox,
                createdAt: h.created_at,
              },
            },
          };
        },
      });
      res.status(result.statusCode).json(result.body);
    })
  );

  app.patch(
    '/api/hackathons/:id',
    requireAuth,
    requireRole(['organizer', 'admin']),
    asyncHandler(async (req, res) => {
      const hackathonId = z.string().uuid().parse(req.params.id);
      const parsed = z
        .object({
          name: z.string().trim().min(3).max(140).optional(),
          description: z.string().trim().max(1000).optional(),
          registrationStatus: z.enum(['draft', 'open', 'closed']).optional(),
          teamFormationStatus: z.enum(['open', 'locked', 'closed']).optional(),
          minTeamSize: z.number().int().min(1).max(10).optional(),
          maxTeamSize: z.number().int().min(1).max(20).optional(),
        })
        .parse(req.body ?? {});

      const existing = await db.query<{
        id: string;
        name: string;
        description: string;
        registration_status: string;
        team_formation_status: string;
        min_team_size: number;
        max_team_size: number;
      }>('SELECT * FROM hackathons WHERE id = $1', [hackathonId]);
      if (existing.rows.length === 0) {
        throw new AppError(404, 'HACKATHON_NOT_FOUND', 'Hackathon not found.');
      }
      const cur = existing.rows[0];
      const nextMin = parsed.minTeamSize ?? cur.min_team_size;
      const nextMax = parsed.maxTeamSize ?? cur.max_team_size;
      if (nextMax < nextMin) {
        throw new AppError(400, 'INVALID_TEAM_SIZE', 'maxTeamSize must be >= minTeamSize.');
      }

      const updated = await db.query(
        `UPDATE hackathons
         SET name = $2,
             description = $3,
             registration_status = $4,
             team_formation_status = $5,
             min_team_size = $6,
             max_team_size = $7
         WHERE id = $1
         RETURNING *`,
        [
          hackathonId,
          parsed.name ?? cur.name,
          parsed.description ?? cur.description,
          parsed.registrationStatus ?? cur.registration_status,
          parsed.teamFormationStatus ?? cur.team_formation_status,
          nextMin,
          nextMax,
        ]
      );
      res.json({ hackathon: updated.rows[0] });
    })
  );

  // --- ANALYTICS OVERVIEW ---
  app.get(
    '/api/analytics/overview',
    asyncHandler(async (_req, res) => {
      const statsRes = await db.query<{
        total_users: string;
        total_teams: string;
        total_memberships: string;
        open_seats: string;
        ready_teams: string;
        audit_events: string;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE email NOT LIKE 'racelab-bot-%')::text AS total_users,
           (SELECT COUNT(*) FROM teams WHERE is_demo_sandbox = FALSE)::text AS total_teams,
           (SELECT COUNT(*) FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.is_demo_sandbox = FALSE)::text AS total_memberships,
           (SELECT COALESCE(SUM(max_capacity - member_count), 0) FROM teams WHERE is_demo_sandbox = FALSE AND status <> 'locked')::text AS open_seats,
           (SELECT COUNT(*) FROM teams WHERE is_demo_sandbox = FALSE AND status = 'ready')::text AS ready_teams,
           (SELECT COUNT(*) FROM audit_logs)::text AS audit_events`
      );

      const s = statsRes.rows[0];
      res.json({
        totalParticipants: Number(s.total_users),
        totalTeams: Number(s.total_teams),
        totalMemberships: Number(s.total_memberships),
        openSeats: Number(s.open_seats),
        readyTeams: Number(s.ready_teams),
        auditEvents: Number(s.audit_events),
      });
    })
  );

  // --- TEAMS DISCOVERY BOARD (Optimized single-RTT parallel pagination) ---
  app.get(
    '/api/teams',
    asyncHandler(async (req, res) => {
      const rawHackathonId =
        typeof req.query.hackathonId === 'string' && req.query.hackathonId.trim()
          ? req.query.hackathonId.trim()
          : undefined;
      const hackathonId = rawHackathonId ? z.string().uuid().parse(rawHackathonId) : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const skill = typeof req.query.skill === 'string' ? req.query.skill.trim() : undefined;
      const search = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;
      const openOnly = req.query.openOnly === 'true';
      const includeSandbox = req.query.includeSandbox === 'true';
      const sandboxOnly = req.query.sandboxOnly === 'true';
      const page = parsePositiveInt(req.query.page, 1, 10000);
      const limit = parsePositiveInt(req.query.limit, 20, 50);
      const offset = (page - 1) * limit;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (sandboxOnly) {
        conditions.push('t.is_demo_sandbox = TRUE');
      } else if (!includeSandbox) {
        conditions.push('t.is_demo_sandbox = FALSE');
      }
      if (hackathonId) {
        params.push(hackathonId);
        conditions.push(`t.hackathon_id = $${params.length}`);
      }
      if (status && ['forming', 'ready', 'locked'].includes(status)) {
        params.push(status);
        conditions.push(`t.status = $${params.length}`);
      }
      if (openOnly) {
        conditions.push(`t.member_count < t.max_capacity AND t.status <> 'locked'`);
      }
      if (skill) {
        params.push(skill);
        conditions.push(
          `EXISTS (SELECT 1 FROM unnest(t.required_skills) AS sk WHERE LOWER(sk) = LOWER($${params.length}))`
        );
      }
      if (search) {
        params.push(`%${search}%`);
        conditions.push(`(t.name ILIKE $${params.length} OR t.description ILIKE $${params.length})`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rowParams = [...params, limit, offset];

      const [countRes, rows] = await Promise.all([
        db.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM teams t ${whereClause}`,
          params
        ),
        db.query<{
          id: string;
          hackathon_id: string;
          hackathon_name: string;
          min_team_size: number;
          name: string;
          description: string;
          leader_id: string;
          leader_name: string;
          leader_timezone: string;
          member_count: number;
          max_capacity: number;
          required_skills: string[];
          status: string;
          is_demo_sandbox: boolean;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT t.id, t.hackathon_id, h.name AS hackathon_name, h.min_team_size,
                  t.name, t.description, t.leader_id, u.full_name AS leader_name, u.timezone AS leader_timezone,
                  t.member_count, t.max_capacity, t.required_skills, t.status, t.is_demo_sandbox,
                  t.created_at, t.updated_at
           FROM teams t
           JOIN hackathons h ON h.id = t.hackathon_id
           JOIN users u ON u.id = t.leader_id
           ${whereClause}
           ORDER BY t.created_at DESC
           LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`,
          rowParams
        ),
      ]);
      const total = Number(countRes.rows[0].total);

      res.json({
        teams: rows.rows.map((t) => ({
          id: t.id,
          hackathonId: t.hackathon_id,
          hackathonName: t.hackathon_name,
          minTeamSize: t.min_team_size,
          name: t.name,
          description: t.description,
          leaderId: t.leader_id,
          leaderName: t.leader_name,
          leaderTimezone: t.leader_timezone,
          memberCount: t.member_count,
          maxCapacity: t.max_capacity,
          openSeats: Math.max(0, t.max_capacity - t.member_count),
          requiredSkills: t.required_skills,
          status: t.status,
          isDemoSandbox: t.is_demo_sandbox,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      });
    })
  );

  // --- TEAM DETAIL ---
  app.get(
    '/api/teams/:id',
    optionalAuth,
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);

      const teamRes = await db.query<{
        id: string;
        hackathon_id: string;
        hackathon_name: string;
        min_team_size: number;
        max_team_size: number;
        name: string;
        description: string;
        leader_id: string;
        leader_name: string;
        leader_timezone: string;
        member_count: number;
        max_capacity: number;
        required_skills: string[];
        status: string;
        is_demo_sandbox: boolean;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT t.*, h.name AS hackathon_name, h.min_team_size, h.max_team_size,
                u.full_name AS leader_name, u.timezone AS leader_timezone
         FROM teams t
         JOIN hackathons h ON h.id = t.hackathon_id
         JOIN users u ON u.id = t.leader_id
         WHERE t.id = $1`,
        [teamId]
      );

      if (teamRes.rows.length === 0) {
        throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
      }
      const t = teamRes.rows[0];

      const membersRes = await db.query<{
        user_id: string;
        full_name: string;
        email: string;
        skills: string[];
        experience_level: string;
        timezone: string;
        role: string;
        joined_at: string;
      }>(
        `SELECT tm.user_id, u.full_name, u.email, u.skills, u.experience_level, u.timezone,
                tm.role, tm.joined_at
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1
         ORDER BY tm.joined_at ASC`,
        [teamId]
      );

      const isLeaderOrAdmin =
        req.user && (req.user.id === t.leader_id || req.user.role === 'admin');

      let joinRequests: Array<{
        id: string;
        userId: string;
        fullName: string;
        skills: string[];
        experienceLevel: string;
        timezone: string;
        message: string;
        status: string;
        createdAt: string;
      }> = [];

      if (isLeaderOrAdmin) {
        const jrRes = await db.query<{
          id: string;
          user_id: string;
          full_name: string;
          skills: string[];
          experience_level: string;
          timezone: string;
          message: string;
          status: string;
          created_at: string;
        }>(
          `SELECT jr.id, jr.user_id, u.full_name, u.skills, u.experience_level, u.timezone,
                  jr.message, jr.status, jr.created_at
           FROM join_requests jr
           JOIN users u ON u.id = jr.user_id
           WHERE jr.team_id = $1 AND jr.status = 'pending'
           ORDER BY jr.created_at ASC`,
          [teamId]
        );
        joinRequests = jrRes.rows.map((r) => ({
          id: r.id,
          userId: r.user_id,
          fullName: r.full_name,
          skills: r.skills,
          experienceLevel: r.experience_level,
          timezone: r.timezone,
          message: r.message,
          status: r.status,
          createdAt: r.created_at,
        }));
      }

      let invites: Array<{
        id: string;
        codePrefix: string;
        maxUses: number;
        usesCount: number;
        expiresAt: string;
        revokedAt: string | null;
        createdAt: string;
      }> = [];

      if (isLeaderOrAdmin) {
        const invRes = await db.query<{
          id: string;
          code_prefix: string;
          max_uses: number;
          uses_count: number;
          expires_at: string;
          revoked_at: string | null;
          created_at: string;
        }>(
          `SELECT id, code_prefix, max_uses, uses_count, expires_at, revoked_at, created_at
           FROM invite_codes
           WHERE team_id = $1
           ORDER BY created_at DESC
           LIMIT 20`,
          [teamId]
        );
        invites = invRes.rows.map((inv) => ({
          id: inv.id,
          codePrefix: inv.code_prefix,
          maxUses: inv.max_uses,
          usesCount: inv.uses_count,
          expiresAt: inv.expires_at,
          revokedAt: inv.revoked_at,
          createdAt: inv.created_at,
        }));
      }

      res.json({
        team: {
          id: t.id,
          hackathonId: t.hackathon_id,
          hackathonName: t.hackathon_name,
          minTeamSize: t.min_team_size,
          maxTeamSize: t.max_team_size,
          name: t.name,
          description: t.description,
          leaderId: t.leader_id,
          leaderName: t.leader_name,
          leaderTimezone: t.leader_timezone,
          memberCount: t.member_count,
          maxCapacity: t.max_capacity,
          openSeats: Math.max(0, t.max_capacity - t.member_count),
          requiredSkills: t.required_skills,
          status: t.status,
          isDemoSandbox: t.is_demo_sandbox,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
        },
        members: membersRes.rows.map((m) => ({
          userId: m.user_id,
          fullName: m.full_name,
          skills: m.skills,
          experienceLevel: m.experience_level,
          timezone: m.timezone,
          role: m.role,
          joinedAt: m.joined_at,
        })),
        joinRequests,
        invites,
      });
    })
  );

  // --- CREATE TEAM (Idempotent) ---
  app.post(
    '/api/teams',
    requireAuth,
    asyncHandler(async (req, res) => {
      const parsed = createTeamSchema.parse(req.body);
      const idempKey = req.header('Idempotency-Key');

      const result = await executeIdempotent(db, {
        scopeKey: `${req.user!.id}:POST:/api/teams`,
        idempotencyKey: idempKey,
        payload: parsed,
        run: async (tx) => {
          const team = await createTeamInTx(db, tx, {
            hackathonId: parsed.hackathonId,
            actorId: req.user!.id,
            name: parsed.name,
            description: parsed.description,
            maxCapacity: parsed.maxCapacity,
            requiredSkills: parsed.requiredSkills,
          });
          return { statusCode: 201, body: { team } };
        },
      });

      if (result.replayed) res.setHeader('X-Idempotent-Replay', 'true');
      res.status(result.statusCode).json(result.body);
    })
  );

  // --- UPDATE TEAM (Idempotent) ---
  app.patch(
    '/api/teams/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);
      const parsed = updateTeamSchema.parse(req.body);
      const idempKey = req.header('Idempotency-Key');

      const result = await executeIdempotent(db, {
        scopeKey: `${req.user!.id}:PATCH:/api/teams/${teamId}`,
        idempotencyKey: idempKey,
        payload: parsed,
        run: async (tx) => {
          const team = await updateTeamInTx(db, tx, {
            teamId,
            actorId: req.user!.id,
            actorRole: req.user!.role,
            ...parsed,
          });
          return { statusCode: 200, body: { team } };
        },
      });

      if (result.replayed) res.setHeader('X-Idempotent-Replay', 'true');
      res.status(result.statusCode).json(result.body);
    })
  );

  // --- DELETE TEAM ---
  app.delete(
    '/api/teams/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);
      const result = await db.withTransaction((tx) =>
        deleteTeamInTx(db, tx, {
          teamId,
          actorId: req.user!.id,
          actorRole: req.user!.role,
        })
      );
      res.json(result);
    })
  );

  // --- RACE-SAFE JOIN TEAM / REDEEM INVITE (Idempotent) ---
  app.post(
    '/api/teams/:id/join',
    requireAuth,
    joinLimiter,
    inviteBruteForceLimiter,
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);
      const parsed = joinTeamSchema.parse(req.body ?? {});
      const idempKey = req.header('Idempotency-Key');

      const result = await executeIdempotent(db, {
        scopeKey: `${req.user!.id}:POST:/api/teams/${teamId}/join`,
        idempotencyKey: idempKey,
        payload: parsed,
        run: async (tx) => {
          const joinResult = await directJoinTeamInTx(db, tx, {
            teamId,
            userId: req.user!.id,
            inviteCode: parsed.inviteCode,
            source: parsed.inviteCode ? 'invite' : 'direct',
          });
          return { statusCode: 200, body: joinResult };
        },
      });

      if (result.replayed) res.setHeader('X-Idempotent-Replay', 'true');
      res.status(result.statusCode).json(result.body);
    })
  );

  // --- LEAVE TEAM ---
  app.post(
    '/api/teams/:id/leave',
    requireAuth,
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);
      const result = await db.withTransaction((tx) =>
        leaveTeamInTx(db, tx, { teamId, userId: req.user!.id })
      );
      res.json(result);
    })
  );

  // --- REMOVE MEMBER ---
  app.delete(
    '/api/teams/:id/members/:userId',
    requireAuth,
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);
      const targetUserId = z.string().uuid().parse(req.params.userId);
      const team = await db.withTransaction((tx) =>
        removeMemberInTx(db, tx, {
          teamId,
          targetUserId,
          actorId: req.user!.id,
          actorRole: req.user!.role,
        })
      );
      res.json({ team });
    })
  );

  // --- TRANSFER LEADERSHIP ---
  app.post(
    '/api/teams/:id/transfer-leadership',
    requireAuth,
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);
      const { newLeaderId } = z.object({ newLeaderId: z.string().uuid() }).parse(req.body);
      const team = await db.withTransaction((tx) =>
        transferLeadershipInTx(db, tx, {
          teamId,
          newLeaderId,
          actorId: req.user!.id,
          actorRole: req.user!.role,
        })
      );
      res.json({ team });
    })
  );

  // --- JOIN REQUESTS ---
  app.post(
    '/api/teams/:id/join-requests',
    requireAuth,
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);
      const parsed = joinRequestSchema.parse(req.body ?? {});
      const idempKey = req.header('Idempotency-Key');

      const result = await executeIdempotent(db, {
        scopeKey: `${req.user!.id}:POST:/api/teams/${teamId}/join-requests`,
        idempotencyKey: idempKey,
        payload: parsed,
        run: async (tx) => {
          const joinRequest = await createJoinRequestInTx(db, tx, {
            teamId,
            userId: req.user!.id,
            message: parsed.message,
          });
          return { statusCode: 201, body: { joinRequest } };
        },
      });

      if (result.replayed) res.setHeader('X-Idempotent-Replay', 'true');
      res.status(result.statusCode).json(result.body);
    })
  );

  app.post(
    '/api/teams/:id/join-requests/:requestId/accept',
    requireAuth,
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);
      const requestId = z.string().uuid().parse(req.params.requestId);
      const idempKey = req.header('Idempotency-Key');

      const result = await executeIdempotent(db, {
        scopeKey: `${req.user!.id}:POST:/api/teams/${teamId}/join-requests/${requestId}/accept`,
        idempotencyKey: idempKey,
        payload: { teamId, requestId },
        run: async (tx) => {
          const accepted = await acceptJoinRequestInTx(db, tx, {
            teamId,
            requestId,
            actorId: req.user!.id,
            actorRole: req.user!.role,
          });
          return { statusCode: 200, body: accepted };
        },
      });

      if (result.replayed) res.setHeader('X-Idempotent-Replay', 'true');
      res.status(result.statusCode).json(result.body);
    })
  );

  app.post(
    '/api/teams/:id/join-requests/:requestId/reject',
    requireAuth,
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);
      const requestId = z.string().uuid().parse(req.params.requestId);
      const idempKey = req.header('Idempotency-Key');

      const result = await executeIdempotent(db, {
        scopeKey: `${req.user!.id}:POST:/api/teams/${teamId}/join-requests/${requestId}/reject`,
        idempotencyKey: idempKey,
        payload: { teamId, requestId },
        run: async (tx) => {
          const joinRequest = await rejectJoinRequestInTx(db, tx, {
            teamId,
            requestId,
            actorId: req.user!.id,
            actorRole: req.user!.role,
          });
          return { statusCode: 200, body: { joinRequest } };
        },
      });

      if (result.replayed) res.setHeader('X-Idempotent-Replay', 'true');
      res.status(result.statusCode).json(result.body);
    })
  );

  // --- SECURE INVITES ---
  app.post(
    '/api/teams/:id/invites',
    requireAuth,
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);
      const parsed = createInviteSchema.parse(req.body ?? {});
      const invite = await db.withTransaction((tx) =>
        createTeamInvite(tx, {
          teamId,
          actorId: req.user!.id,
          actorRole: req.user!.role,
          expiresInHours: parsed.expiresInHours,
          maxUses: parsed.maxUses,
        })
      );
      res.status(201).json({ invite });
    })
  );

  app.delete(
    '/api/teams/:id/invites/:inviteId',
    requireAuth,
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);
      const inviteId = z.string().uuid().parse(req.params.inviteId);
      const revoked = await db.withTransaction((tx) =>
        revokeTeamInvite(tx, {
          teamId,
          inviteId,
          actorId: req.user!.id,
          actorRole: req.user!.role,
        })
      );
      res.json({ revoked });
    })
  );

  // --- DETERMINISTIC TEAMMATE RECOMMENDATIONS ---
  app.get(
    '/api/teams/:id/recommendations',
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.id);
      const limit = parsePositiveInt(req.query.limit, 8, 25);

      const teamRes = await db.query<{
        id: string;
        hackathon_id: string;
        required_skills: string[];
        leader_timezone: string;
      }>(
        `SELECT t.id, t.hackathon_id, t.required_skills, u.timezone AS leader_timezone
         FROM teams t
         JOIN users u ON u.id = t.leader_id
         WHERE t.id = $1`,
        [teamId]
      );
      if (teamRes.rows.length === 0) {
        throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
      }
      const team = teamRes.rows[0];

      const memberSkillsRes = await db.query<{ skills: string[] }>(
        `SELECT u.skills
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1`,
        [teamId]
      );
      const existingMemberSkills = memberSkillsRes.rows.flatMap((r) => r.skills);

      // Exclude users already belonging to any team in the same hackathon + synthetic racelab bots
      const candidatesRes = await db.query<{
        id: string;
        full_name: string;
        skills: string[];
        experience_level: string;
        timezone: string;
      }>(
        `SELECT u.id, u.full_name, u.skills, u.experience_level, u.timezone
         FROM users u
         WHERE u.email NOT LIKE 'racelab-bot-%'
           AND NOT EXISTS (
             SELECT 1 FROM team_members tm
             WHERE tm.hackathon_id = $1 AND tm.user_id = u.id
           )
         LIMIT 500`,
        [team.hackathon_id]
      );

      const recommendations = rankTeammateCandidates(
        candidatesRes.rows.map((c) => ({
          id: c.id,
          fullName: c.full_name,
          skills: c.skills,
          experienceLevel: c.experience_level,
          timezone: c.timezone,
        })),
        {
          requiredSkills: team.required_skills,
          existingMemberSkills,
          leaderTimezone: team.leader_timezone,
        },
        limit
      );

      res.json({ recommendations });
    })
  );

  // --- AUDIT EXPLORER ---
  app.get(
    '/api/audit-logs',
    asyncHandler(async (req, res) => {
      const rawTeamId =
        typeof req.query.teamId === 'string' && req.query.teamId.trim()
          ? req.query.teamId.trim()
          : undefined;
      const teamId = rawTeamId ? z.string().uuid().parse(rawTeamId) : undefined;
      const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : undefined;
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;
      const page = parsePositiveInt(req.query.page, 1, 10000);
      const limit = parsePositiveInt(req.query.limit, 30, 100);
      const offset = (page - 1) * limit;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (teamId) {
        params.push(teamId);
        conditions.push(`a.team_id::text = $${params.length}`);
      }
      if (action) {
        params.push(action);
        conditions.push(`a.action = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        conditions.push(
          `(a.action ILIKE $${params.length} OR a.team_id::text ILIKE $${params.length} OR COALESCE(actor.full_name, '') ILIKE $${params.length} OR a.metadata::text ILIKE $${params.length})`
        );
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const countRes = await db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM audit_logs a
         LEFT JOIN users actor ON actor.id = a.actor_id
         ${whereClause}`,
        params
      );
      const total = Number(countRes.rows[0].total);

      params.push(limit, offset);
      const rows = await db.query<{
        id: string;
        actor_id: string | null;
        actor_name: string | null;
        team_id: string | null;
        hackathon_id: string | null;
        action: string;
        target_user_id: string | null;
        target_name: string | null;
        metadata: Record<string, unknown>;
        created_at: string;
      }>(
        `SELECT a.id, a.actor_id, actor.full_name AS actor_name,
                a.team_id, a.hackathon_id, a.action,
                a.target_user_id, target.full_name AS target_name,
                a.metadata, a.created_at
         FROM audit_logs a
         LEFT JOIN users actor ON actor.id = a.actor_id
         LEFT JOIN users target ON target.id = a.target_user_id
         ${whereClause}
         ORDER BY a.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      res.json({
        logs: rows.rows.map((l) => ({
          id: l.id,
          actorId: l.actor_id,
          actorName: l.actor_name,
          teamId: l.team_id,
          hackathonId: l.hackathon_id,
          action: l.action,
          targetUserId: l.target_user_id,
          targetName: l.target_name,
          metadata: l.metadata,
          createdAt: l.created_at,
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      });
    })
  );

  // --- RACELAB: ISOLATED LIVE CONCURRENCY SANDBOX ---
  app.post(
    '/api/racelab/setup',
    requireAuth,
    requireRole(['admin', 'organizer']),
    asyncHandler(async (req, res) => {
      const parsed = raceLabSetupSchema.parse(req.body ?? {});
      const botHash = await bcrypt.hash('RaceLabSynthetic!2026', 6);

      const setupResult = await db.withTransaction(async (tx) => {
        // Resolve isolated sandbox hackathon
        let hackRes = await tx.query<{ id: string; name: string }>(
          'SELECT id, name FROM hackathons WHERE is_demo_sandbox = TRUE ORDER BY created_at ASC LIMIT 1'
        );
        if (hackRes.rows.length === 0) {
          hackRes = await tx.query<{ id: string; name: string }>(
            `INSERT INTO hackathons (slug, name, description, registration_status, team_formation_status, min_team_size, max_team_size, is_demo_sandbox)
             VALUES ('racelab-sandbox', 'RaceLab Isolated Verification Sandbox', 'Isolated demo sandbox', 'open', 'open', 1, 10, TRUE)
             RETURNING id, name`
          );
        }
        const sandboxHackathon = hackRes.rows[0];

        // Provision or reset target sandbox team
        let targetTeamId = parsed.teamId;
        if (targetTeamId) {
          const checkTeam = await tx.query<{ id: string; is_demo_sandbox: boolean }>(
            'SELECT id, is_demo_sandbox FROM teams WHERE id = $1 FOR UPDATE',
            [targetTeamId]
          );
          if (checkTeam.rows.length === 0 || !checkTeam.rows[0].is_demo_sandbox) {
            throw new AppError(
              403,
              'SANDBOX_ONLY',
              'RaceLab resets are strictly restricted to isolated demo sandbox teams.'
            );
          }
          // Reset team memberships back to only the leader (1 member)
          await tx.query(
            `DELETE FROM team_members WHERE team_id = $1 AND role <> 'leader'`,
            [targetTeamId]
          );
          await tx.query(
            `UPDATE teams SET member_count = 1, max_capacity = $2, status = 'forming', updated_at = NOW() WHERE id = $1`,
            [targetTeamId, 1 + parsed.availableSeats]
          );
        } else {
          const existingSandboxTeam = await tx.query<{ id: string }>(
            'SELECT id FROM teams WHERE hackathon_id = $1 AND is_demo_sandbox = TRUE ORDER BY created_at ASC LIMIT 1 FOR UPDATE',
            [sandboxHackathon.id]
          );
          if (existingSandboxTeam.rows.length > 0) {
            targetTeamId = existingSandboxTeam.rows[0].id;
            await tx.query(
              `DELETE FROM team_members WHERE team_id = $1 AND role <> 'leader'`,
              [targetTeamId]
            );
            await tx.query(
              `UPDATE teams SET member_count = 1, max_capacity = $2, status = 'forming', updated_at = NOW() WHERE id = $1`,
              [targetTeamId, 1 + parsed.availableSeats]
            );
          } else {
            const created = await createTeamInTx(db, tx, {
              hackathonId: sandboxHackathon.id,
              actorId: req.user!.id,
              name: `RaceLab Contention Team`,
              description: 'Isolated team for genuine 50-request concurrent seat contention verification.',
              maxCapacity: 1 + parsed.availableSeats,
              requiredSkills: ['PostgreSQL', 'SELECT FOR UPDATE'],
              isDemoSandbox: true,
            });
            targetTeamId = created.id;
          }
        }

        // Clear any leftover sandbox memberships & join requests from synthetic bots
        await tx.query(
          `DELETE FROM join_requests WHERE team_id = $1`,
          [targetTeamId]
        );
        await tx.query(
          `DELETE FROM team_members tm
           USING users u
           WHERE tm.user_id = u.id
             AND tm.hackathon_id = $1
             AND u.email LIKE 'racelab-bot-%'`,
          [sandboxHackathon.id]
        );

        // Ensure competitorCount synthetic users exist in DB and generate signed JWTs for real HTTP requests
        const competitors: Array<{ id: string; fullName: string; email: string; token: string }> = [];
        for (let i = 1; i <= parsed.competitorCount; i++) {
          const email = `racelab-bot-${String(i).padStart(3, '0')}@sandbox.crewforge.dev`;
          const fullName = `Competitor #${String(i).padStart(2, '0')}`;
          const uRes = await tx.query<{ id: string; email: string; role: string; full_name: string }>(
            `INSERT INTO users (full_name, email, password_hash, role, skills, experience_level, timezone)
             VALUES ($1, $2, $3, 'participant', ARRAY['PostgreSQL', 'Distributed Systems'], 'advanced', 'UTC')
             ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
             RETURNING id, email, role, full_name`,
            [fullName, email, botHash]
          );
          const u = uRes.rows[0];
          competitors.push({
            id: u.id,
            fullName: u.full_name,
            email: u.email,
            token: signSessionToken(u),
          });
        }

        const teamDetail = await tx.query<{
          id: string;
          name: string;
          member_count: number;
          max_capacity: number;
        }>('SELECT id, name, member_count, max_capacity FROM teams WHERE id = $1', [targetTeamId]);

        await insertAuditLog(tx, {
          actorId: req.user!.id,
          teamId: targetTeamId,
          hackathonId: sandboxHackathon.id,
          action: 'RACE_LAB_RUN',
          metadata: {
            availableSeats: parsed.availableSeats,
            competitorCount: parsed.competitorCount,
          },
        });

        return {
          hackathonId: sandboxHackathon.id,
          hackathonName: sandboxHackathon.name,
          team: {
            id: teamDetail.rows[0].id,
            name: teamDetail.rows[0].name,
            memberCount: teamDetail.rows[0].member_count,
            maxCapacity: teamDetail.rows[0].max_capacity,
            availableSeats: teamDetail.rows[0].max_capacity - teamDetail.rows[0].member_count,
          },
          competitors,
        };
      });

      res.json(setupResult);
    })
  );

  app.post(
    '/api/racelab/verify/:teamId',
    requireAuth,
    requireRole(['admin', 'organizer']),
    asyncHandler(async (req, res) => {
      const teamId = z.string().uuid().parse(req.params.teamId);
      const { expectedWinners, initialMemberCount } = z
        .object({
          expectedWinners: z.number().int().min(1).max(5).optional().default(1),
          initialMemberCount: z.number().int().min(1).optional().default(1),
        })
        .parse(req.body ?? {});

      const teamRes = await db.query<{
        id: string;
        hackathon_id: string;
        member_count: number;
        max_capacity: number;
      }>('SELECT id, hackathon_id, member_count, max_capacity FROM teams WHERE id = $1', [teamId]);

      if (teamRes.rows.length === 0) {
        throw new AppError(404, 'TEAM_NOT_FOUND', 'Team not found.');
      }
      const team = teamRes.rows[0];

      const actualCountRes = await db.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM team_members WHERE team_id = $1',
        [teamId]
      );
      const actualMemberCount = Number(actualCountRes.rows[0].count);

      const dupesRes = await db.query<{ dupes: string }>(
        `SELECT COUNT(*)::text AS dupes FROM (
           SELECT hackathon_id, user_id, COUNT(*) c
           FROM team_members
           WHERE hackathon_id = $1
           GROUP BY hackathon_id, user_id
           HAVING COUNT(*) > 1
         ) d`,
        [team.hackathon_id]
      );
      const duplicateMemberships = Number(dupesRes.rows[0].dupes);

      const auditCountRes = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_logs WHERE team_id = $1 AND action = 'MEMBERSHIP_CREATED'`,
        [teamId]
      );

      const membersRes = await db.query<{
        user_id: string;
        full_name: string;
        role: string;
        joined_at: string;
      }>(
        `SELECT tm.user_id, u.full_name, tm.role, tm.joined_at
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1
         ORDER BY tm.joined_at ASC`,
        [teamId]
      );

      const assertions = {
        exactExpectedSeatsFilled: actualMemberCount === initialMemberCount + expectedWinners,
        noCapacityViolation:
          team.member_count <= team.max_capacity && actualMemberCount <= team.max_capacity,
        denormalizedCountMatchesActual: team.member_count === actualMemberCount,
        noDuplicateMemberships: duplicateMemberships === 0,
        auditRecordsRecorded: Number(auditCountRes.rows[0].count) >= expectedWinners,
      };

      res.json({
        teamId,
        storedMemberCount: team.member_count,
        actualMemberCount,
        maxCapacity: team.max_capacity,
        duplicateMemberships,
        membershipAuditRecords: Number(auditCountRes.rows[0].count),
        members: membersRes.rows.map((m) => ({
          userId: m.user_id,
          fullName: m.full_name,
          role: m.role,
          joinedAt: m.joined_at,
        })),
        assertions,
        allPassed: Object.values(assertions).every(Boolean),
      });
    })
  );

  // API 404 JSON catch-all so unmatched /api/* paths never fall through to SPA HTML
  app.use('/api', (_req, _res, next) => {
    next(new AppError(404, 'NOT_FOUND', 'API endpoint not found.'));
  });

  // Centralized Error Handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      });
    }

    if (err instanceof z.ZodError) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.issues[0]?.message || 'Invalid request payload.',
          details: err.issues,
        },
      });
    }

    console.error('Unhandled server error:', err);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred.',
      },
    });
  });

  return app;
}
