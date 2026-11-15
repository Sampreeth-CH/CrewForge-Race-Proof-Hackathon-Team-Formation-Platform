import { Pool, PoolClient, QueryResultRow } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';
import fs from 'node:fs';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
}

export type DbMode = 'pg-pool' | 'pglite';

export class DatabaseManager {
  public readonly mode: DbMode;
  private pool: Pool | null = null;
  private pglite: PGlite | null = null;
  private txQueue: Promise<void> = Promise.resolve();
  private listenClient: PoolClient | null = null;
  private listeners = new Map<string, Set<(payload: string) => void>>();
  private pgliteUnlistenMap = new Map<string, () => Promise<void>>();
  private initPromise: Promise<void> | null = null;

  constructor(options?: { dataDir?: string; forceMemory?: boolean }) {
    const hasExternalPg = Boolean(
      process.env.SQL_HOST || process.env.PGHOST || process.env.DATABASE_URL
    );

    const dbUrl = process.env.DATABASE_URL ?? '';
    const useSsl =
      process.env.SQL_SSL !== 'false' &&
      (process.env.SQL_SSL === 'true' ||
        (Boolean(process.env.PGSSLMODE) && process.env.PGSSLMODE !== 'disable') ||
        /sslmode=(require|verify-ca|verify-full|no-verify)|[?&]ssl=true/i.test(dbUrl));
    const sslConfig = useSsl ? { rejectUnauthorized: false } : undefined;
    const poolMax = Number(process.env.PG_POOL_MAX ?? 30);

    if (hasExternalPg && !options?.forceMemory) {
      this.mode = 'pg-pool';
      if (process.env.SQL_HOST) {
        this.pool = new Pool({
          host: process.env.SQL_HOST,
          port: process.env.SQL_PORT ? Number(process.env.SQL_PORT) : 5432,
          user: process.env.SQL_USER,
          password: process.env.SQL_PASSWORD,
          database: process.env.SQL_DB_NAME || process.env.SQL_DATABASE || 'crewforge',
          max: poolMax,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 15000,
          ssl: sslConfig,
        });
      } else if (process.env.PGHOST) {
        this.pool = new Pool({
          host: process.env.PGHOST,
          port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
          database: process.env.PGDATABASE,
          max: poolMax,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 15000,
          ssl: sslConfig,
        });
      } else {
        this.pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: poolMax,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 15000,
          ssl: sslConfig,
        });
      }

      this.pool.on('error', (err) => {
        console.error('Unexpected PostgreSQL pool error:', err);
      });
    } else {
      this.mode = 'pglite';
      const targetDir = options?.forceMemory
        ? 'memory://'
        : options?.dataDir ?? process.env.PGLITE_DATA_DIR ?? path.resolve(process.cwd(), '.pgdata');

      if (targetDir !== 'memory://' && !fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      this.pglite = new PGlite(targetDir);
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.mode === 'pglite' && this.pglite) {
      if (!this.initPromise) {
        this.initPromise = this.pglite.waitReady;
      }
      await this.initPromise;
    }
  }

  async query<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<QueryResult<T>> {
    await this.ensureReady();
    if (this.mode === 'pg-pool' && this.pool) {
      const result = await this.pool.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    }
    if (this.pglite) {
      const result = await this.pglite.query<T>(sql, params);
      return {
        rows: result.rows,
        rowCount: result.affectedRows ?? result.rows.length,
      };
    }
    throw new Error('Database client is not initialized.');
  }

  /**
   * Executes a callback inside an ACID PostgreSQL transaction (BEGIN ... COMMIT / ROLLBACK).
   */
  async withTransaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    await this.ensureReady();

    if (this.mode === 'pg-pool' && this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const txClient: DbClient = {
          query: async <R extends QueryResultRow = Record<string, unknown>>(
            sql: string,
            params: unknown[] = []
          ) => {
            const res = await client.query<R>(sql, params);
            return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
          },
        };
        const result = await fn(txClient);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rbErr) {
          console.error('Transaction rollback error:', rbErr);
        }
        throw err;
      } finally {
        client.release();
      }
    }

    if (this.pglite) {
      // Serialize concurrent BEGIN/COMMIT blocks on single-connection WASM PostgreSQL
      let releaseQueue!: () => void;
      const previous = this.txQueue;
      this.txQueue = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      await previous;

      try {
        await this.pglite.query('BEGIN');
        const txClient: DbClient = {
          query: async <R extends QueryResultRow = Record<string, unknown>>(
            sql: string,
            params: unknown[] = []
          ) => {
            const res = await this.pglite!.query<R>(sql, params);
            return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
          },
        };
        const result = await fn(txClient);
        await this.pglite.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await this.pglite.query('ROLLBACK');
        } catch (rbErr) {
          console.error('Transaction rollback error:', rbErr);
        }
        throw err;
      } finally {
        releaseQueue();
      }
    }

    throw new Error('Database client is not initialized.');
  }

  /**
   * Emits a PostgreSQL NOTIFY inside an active transaction so subscribers only
   * receive the event if and when the transaction commits.
   */
  async notifyInTx(tx: DbClient, channel: string, payload: unknown): Promise<void> {
    await tx.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload)]);
  }

  /**
   * Subscribes to PostgreSQL LISTEN/NOTIFY channel.
   */
  async listen(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>> {
    await this.ensureReady();
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(handler);

    if (this.mode === 'pg-pool' && this.pool) {
      if (!this.listenClient) {
        this.listenClient = await this.pool.connect();
        this.listenClient.on('notification', (msg) => {
          if (!msg.payload) return;
          const handlers = this.listeners.get(msg.channel);
          if (handlers) {
            handlers.forEach((h) => h(msg.payload!));
          }
        });
      }
      await this.listenClient.query(`LISTEN ${channel.replace(/[^a-zA-Z0-9_]/g, '')}`);
    } else if (this.pglite && !this.pgliteUnlistenMap.has(channel)) {
      const unlisten = await this.pglite.listen(channel, (payload) => {
        const handlers = this.listeners.get(channel);
        if (handlers) {
          handlers.forEach((h) => h(payload));
        }
      });
      this.pgliteUnlistenMap.set(channel, unlisten);
    }

    return async () => {
      const current = this.listeners.get(channel);
      if (current) {
        current.delete(handler);
      }
    };
  }

  async execRaw(sql: string): Promise<void> {
    await this.ensureReady();
    if (this.mode === 'pg-pool' && this.pool) {
      await this.pool.query(sql);
      return;
    }
    if (this.pglite) {
      await this.pglite.exec(sql);
      return;
    }
    throw new Error('Database client is not initialized.');
  }

  async close(): Promise<void> {
    if (this.listenClient) {
      this.listenClient.release();
      this.listenClient = null;
    }
    for (const unlisten of this.pgliteUnlistenMap.values()) {
      await unlisten();
    }
    this.pgliteUnlistenMap.clear();
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    if (this.pglite) {
      await this.pglite.close();
      this.pglite = null;
    }
  }
}

let defaultDb: DatabaseManager | null = null;

export function getDb(): DatabaseManager {
  if (!defaultDb) {
    defaultDb = new DatabaseManager();
  }
  return defaultDb;
}
