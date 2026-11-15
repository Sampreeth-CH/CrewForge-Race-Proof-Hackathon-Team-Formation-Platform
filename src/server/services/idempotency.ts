import crypto from 'node:crypto';
import { DatabaseManager, DbClient } from '../db/client.ts';
import { AppError, isPgError } from '../errors.ts';
import { canonicalizePayload } from '../../shared/logic.ts';

export interface IdempotentResult<T> {
  statusCode: number;
  body: T;
  replayed: boolean;
}

export function hashRequestPayload(payload: unknown): string {
  const canonical = canonicalizePayload(payload ?? {});
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Executes a mutation transactionally with Idempotency-Key deduplication.
 * - Same key + same payload -> returns original statusCode & response_body
 * - Same key + different payload -> throws 409 IDEMPOTENCY_CONFLICT
 * - Concurrent duplicate retries -> handled safely via UNIQUE (scope_key, idempotency_key)
 */
export async function executeIdempotent<T>(
  db: DatabaseManager,
  params: {
    scopeKey: string;
    idempotencyKey?: string;
    payload: unknown;
    run: (tx: DbClient) => Promise<{ statusCode: number; body: T }>;
  }
): Promise<IdempotentResult<T>> {
  const { scopeKey, idempotencyKey, payload, run } = params;

  if (!idempotencyKey || !idempotencyKey.trim()) {
    const res = await db.withTransaction((tx) => run(tx));
    return { ...res, replayed: false };
  }

  const trimmedKey = idempotencyKey.trim();
  if (trimmedKey.length > 128) {
    throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key header exceeds 128 characters.');
  }

  const requestHash = hashRequestPayload(payload);

  try {
    return await db.withTransaction(async (tx) => {
      // Serialize concurrent first-flight requests sharing the same (scopeKey, idempotencyKey)
      // across independent pg.Pool connections until the first transaction commits.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        scopeKey,
        trimmedKey,
      ]);

      const existing = await tx.query<{
        request_hash: string;
        status_code: number;
        response_body: T;
      }>(
        `SELECT request_hash, status_code, response_body
         FROM idempotency_keys
         WHERE scope_key = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [scopeKey, trimmedKey]
      );

      if (existing.rows.length > 0) {
        const record = existing.rows[0];
        if (record.request_hash !== requestHash) {
          throw new AppError(
            409,
            'IDEMPOTENCY_PAYLOAD_MISMATCH',
            'Idempotency-Key was already used with a different request payload.'
          );
        }
        return {
          statusCode: record.status_code,
          body: record.response_body,
          replayed: true,
        };
      }

      const result = await run(tx);

      await tx.query(
        `INSERT INTO idempotency_keys (scope_key, idempotency_key, request_hash, status_code, response_body)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [scopeKey, trimmedKey, requestHash, result.statusCode, JSON.stringify(result.body)]
      );

      return { ...result, replayed: false };
    });
  } catch (err) {
    // Handle concurrent first-flight unique constraint race
    if (isPgError(err) && err.code === '23505' && err.constraint?.includes('idempotency')) {
      const existing = await db.query<{
        request_hash: string;
        status_code: number;
        response_body: T;
      }>(
        `SELECT request_hash, status_code, response_body
         FROM idempotency_keys
         WHERE scope_key = $1 AND idempotency_key = $2`,
        [scopeKey, trimmedKey]
      );
      if (existing.rows.length > 0) {
        const record = existing.rows[0];
        if (record.request_hash !== requestHash) {
          throw new AppError(
            409,
            'IDEMPOTENCY_PAYLOAD_MISMATCH',
            'Idempotency-Key was already used with a different request payload.'
          );
        }
        return {
          statusCode: record.status_code,
          body: record.response_body,
          replayed: true,
        };
      }
    }
    throw err;
  }
}
