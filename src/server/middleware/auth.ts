import crypto from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { DatabaseManager } from '../db/client.ts';
import { AppError } from '../errors.ts';

export const AUTH_COOKIE_NAME = 'crewforge_session';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: 'participant' | 'organizer' | 'admin';
  timezone: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

const EPHEMERAL_DEV_SECRET = crypto.randomBytes(32).toString('hex');

function getJwtSecret(): string {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) {
    return process.env.JWT_SECRET;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET environment variable must be configured in production.');
  }
  return EPHEMERAL_DEV_SECRET;
}

export function signSessionToken(user: { id: string; email: string; role: string }): string {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    getJwtSecret(),
    { expiresIn: '24h' }
  );
}

export function setSessionCookie(res: Response, token: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  const forceSecure = process.env.COOKIE_SECURE === 'true';
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd || forceSecure,
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  const isProd = process.env.NODE_ENV === 'production';
  const forceSecure = process.env.COOKIE_SECURE === 'true';
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd || forceSecure,
    path: '/',
  });
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer.length > 0) return bearer;
  }
  const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken.length > 0) {
    return cookieToken;
  }
  return null;
}

export function createAuthMiddleware(db: DatabaseManager) {
  const resolveUser = async (req: AuthRequest): Promise<AuthUser | null> => {
    const token = extractToken(req);
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, getJwtSecret()) as { sub: string };
      const res = await db.query<{
        id: string;
        email: string;
        full_name: string;
        role: 'participant' | 'organizer' | 'admin';
        timezone: string;
      }>('SELECT id, email, full_name, role, timezone FROM users WHERE id = $1', [decoded.sub]);
      if (res.rows.length === 0) return null;
      const row = res.rows[0];
      return {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
        timezone: row.timezone,
      };
    } catch {
      return null;
    }
  };

  const requireAuth = async (req: AuthRequest, _res: Response, next: NextFunction) => {
    try {
      const user = await resolveUser(req);
      if (!user) {
        return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required.'));
      }
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };

  const optionalAuth = async (req: AuthRequest, _res: Response, next: NextFunction) => {
    try {
      const user = await resolveUser(req);
      if (user) req.user = user;
      next();
    } catch {
      next();
    }
  };

  const requireRole = (allowed: Array<'participant' | 'organizer' | 'admin'>) => {
    return (req: AuthRequest, _res: Response, next: NextFunction) => {
      if (!req.user) {
        return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required.'));
      }
      if (!allowed.includes(req.user.role)) {
        return next(new AppError(403, 'FORBIDDEN', 'Insufficient role permissions.'));
      }
      next();
    };
  };

  return { requireAuth, optionalAuth, requireRole };
}
