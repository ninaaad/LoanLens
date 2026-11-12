import { config } from './config.js';
import { createDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { ensureDefaultRules } from './rules/defaultRules.js';
import { seedDatabase } from './data/seed.js';
import { ingest } from './rag/ingest.js';
import { createApp } from './app.js';
import { setMockBaseUrl } from './integrations/providerClient.js';

const db = await createDb();
await migrate(db.pool);
await ensureDefaultRules(db.pool);
const { rows } = await db.pool.query('select count(*)::int n from applications');
if (rows[0].n === 0) {
  console.log('Empty database: seeding synthetic data (set SKIP_SEED=1 to skip)...');
  if (!process.env.SKIP_SEED) console.log(await seedDatabase(db.pool, {}));
}
const chunkCount = (await db.pool.query('select count(*)::int n from rag_chunks')).rows[0].n;
if (chunkCount === 0) {
  try { console.log('Ingesting RBI Digital Lending Directions:', await ingest(db.pool)); } catch (e) { console.warn('RAG ingestion skipped:', e.message); }
}
const app = createApp({ pool: db.pool });
const server = app.listen(config.port, () => {
  setMockBaseUrl(`http://127.0.0.1:${config.port}`);
  console.log(`LoanLens API on http://localhost:${config.port}  (db: ${db.kind}) - all data is synthetic`);
});
server.on('error', async (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Stop the other process or set PORT.` : `Server error: ${e.message}`);
  await db.close().catch(() => {});
  process.exit(1);
});
const stop = async () => { server.close(); await db.close(); process.exit(0); };
// A bug in one request is turned into a 500 by the route wrapper. Anything that escapes it is logged and the process exits,
// so a half-working server is never left running (the embedded database is closed first).
for (const evt of ['uncaughtException', 'unhandledRejection']) {
  process.on(evt, async (e) => {
    console.error(`Fatal (${evt}):`, e);
    await db.close().catch(() => {});
    process.exit(1);
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
