import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { getDb } from './src/server/db/client.ts';
import { initializeDatabase } from './src/server/db/bootstrap.ts';
import { createApp } from './src/server/app.ts';
import { sseHub } from './src/server/services/sse.ts';

async function startServer() {
  const PORT = Number(process.env.PORT ?? 3000);
  const db = getDb();

  await initializeDatabase(db);
  await sseHub.init(db);

  const app = createApp(db);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`CrewForge server running on http://0.0.0.0:${PORT} (db=${db.mode})`);
  });

  const shutdown = async () => {
    await sseHub.shutdown();
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
