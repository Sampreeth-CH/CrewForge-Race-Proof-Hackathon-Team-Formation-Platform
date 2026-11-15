import fs from 'node:fs';
import path from 'node:path';
import { DatabaseManager, getDb } from './client.ts';

export async function runMigrations(db: DatabaseManager = getDb()): Promise<void> {
  await db.execRaw(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found at ${migrationsDir}`);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const existing = await db.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [file]
    );
    if (existing.rows.length > 0) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await db.execRaw(sql);
    await db.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [
      file,
    ]);
  }
}

// Allow CLI execution via: npx tsx src/server/db/migrate.ts
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  runMigrations()
    .then(async () => {
      console.log('Migrations applied successfully.');
      await getDb().close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await getDb().close();
      process.exit(1);
    });
}
