import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase, runMigrations } from '../db/database.ts';
import { Repository } from '../db/repository.ts';
import { buildApp, listenLocal } from './app.ts';

/**
 * Local-only HTTP server. Binds 127.0.0.1 on an OS-assigned free port and
 * records the chosen port under data/ so project tooling (and only this
 * project) can stop it later.
 */
async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'app.sqlite');
  const db = openDatabase(dbPath);
  runMigrations(db);
  const repo = new Repository(db);
  const server = buildApp(repo);
  const { port, host } = await listenLocal(server);
  writeFileSync(
    join(dataDir, 'server.json'),
    JSON.stringify({ host, port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
  );
  console.log(`[server] listening on http://${host}:${port} (pid ${process.pid})`);
  console.log(`[server] sqlite at ${dbPath}`);

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
