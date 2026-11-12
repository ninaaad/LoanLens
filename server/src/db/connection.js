import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

// pg returns NUMERIC as string; the app wants numbers.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

// Windows: PostgreSQL's auxiliary workers (io_worker, bgwriter, ...) can outlive the postmaster after it stops and keep running
// (about one test file in three left one behind). So at shutdown we remember the postmaster's descendants, stop it, and then end any
// postgres.exe that is still a child of one of them. Only processes that descend from the postmaster this module started are touched.
function listProcesses() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }'], { encoding: 'utf8', timeout: 15000 });
    return out.split(/\r?\n/).map((l) => l.split('|')).filter((p) => p.length >= 3 && Number(p[0]))
      .map(([pid, ppid, name, ...cmd]) => ({ pid: Number(pid), ppid: Number(ppid), name: name.trim(), cmd: cmd.join('|') }));
  } catch { return []; }
}

/**
 * postgres.exe processes of THIS project's embedded server whose parent no longer exists. When a dev run is killed hard (closing the
 * terminal, Ctrl+C through a process manager, a crash), the postmaster can die while a child such as "startup" survives and keeps
 * the listening socket, so the port looks taken but nothing answers. Pure function so it can be tested; `home` is the project folder.
 */
export function strandedPostgres(procs, home) {
  const live = new Set(procs.map((p) => p.pid));
  const mine = home.toLowerCase().replaceAll('\\', '/');
  return procs
    .filter((p) => p.name.toLowerCase() === 'postgres.exe' && !live.has(p.ppid))
    .filter((p) => { const c = (p.cmd ?? '').toLowerCase().replaceAll('\\', '/'); return c.includes(mine) && c.includes('@embedded-postgres'); })
    .map((p) => p.pid);
}
function windowsFamily(rootPid, procs = listProcesses()) {
  const family = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) if (family.has(p.ppid) && !family.has(p.pid)) { family.add(p.pid); grew = true; }
  }
  return family;
}
function killWindowsPostgres(pids) {
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/FI', `PID eq ${pid}`, '/FI', 'IMAGENAME eq postgres.exe', '/F'], { stdio: 'ignore', timeout: 15000 }); } catch { /* already gone */ }
  }
}

async function canConnect(opts) {
  const client = new pg.Client({ ...opts, connectionTimeoutMillis: 1500 });
  client.on('error', () => {});
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}

/**
 * Create a database handle.
 *  - DATABASE_URL set  -> plain Postgres.
 *  - otherwise          -> embedded Postgres (real Postgres binaries from npm), persistent in .data/pg.
 *  - { ephemeral:true } -> throwaway embedded Postgres in a temp dir (tests).
 */
export async function createDb({ ephemeral = false } = {}) {
  if (config.databaseUrl && !ephemeral) {
    const pool = new Pool({ connectionString: config.databaseUrl, options: '-c timezone=UTC' });
    pool.on('error', (e) => console.error('Database pool error:', e.message)); // an idle client dropping must not crash the process
    return { pool, close: () => pool.end(), kind: 'external' };
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dataDir = ephemeral ? fs.mkdtempSync(path.join(os.tmpdir(), 'loanlens-pg-')) : config.dataDir;
  const port = ephemeral ? 55000 + Math.floor(Math.random() * 4000) : config.embeddedPort;
  const password = 'loanlens';

  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password,
    port,
    persistent: !ephemeral,
    // Windows initdb defaults to WIN1252, which cannot store the rupee sign used in rule JSON.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: () => {},
  });

  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    fs.mkdirSync(dataDir, { recursive: true });
    await server.initialise();
  }
  // A previous run that was killed (not stopped) can leave its PostgreSQL running on this port. Reuse it instead of
  // failing to start a second one, which used to surface as an uncaught "undefined" at start-up.
  const alreadyRunning = !ephemeral && (await canConnect({ host: 'localhost', port, user: 'postgres', password, database: 'postgres' }));
  if (!alreadyRunning) {
    try {
      try {
        await server.start();
      } catch (first) {
        // Nothing answered on the port but something holds it: clear this project's stranded postgres processes and try once more.
        const stranded = process.platform === 'win32' && !ephemeral ? strandedPostgres(listProcesses(), path.resolve(config.root, '..')) : [];
        if (!stranded.length) throw first;
        console.warn(`Embedded PostgreSQL could not start; ending ${stranded.length} stranded postgres process(es) from an earlier run and retrying.`);
        killWindowsPostgres(stranded);
        await new Promise((r) => setTimeout(r, 1500));
        await server.start();
      }
    } catch (e) {
      throw new Error(`Could not start the embedded PostgreSQL on port ${port} (${e?.message || 'no details given'}). If a postgres process from an earlier run is still alive, stop it or set EMBEDDED_PG_PORT.`);
    }
  }
  try {
    await server.createDatabase('loanlens');
  } catch {
    /* already exists */
  }

  const pool = new Pool({
    host: 'localhost', port, user: 'postgres', password, database: 'loanlens',
    options: '-c timezone=UTC', max: 10,
  });

  pool.on('error', (e) => console.error('Database pool error:', e.message));

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await pool.end().catch(() => {});
    const child = server.process;
    let family = new Set();
    if (!alreadyRunning) {
      if (process.platform === 'win32' && child?.pid) family = windowsFamily(child.pid);
      await server.stop().catch(() => {});
      if (family.size) {
        killWindowsPostgres([...family]);
        // workers that were forked while we were shutting down show up as children of the family; end those too
        const stragglers = listProcesses().filter((p) => p.name.toLowerCase() === 'postgres.exe' && family.has(p.ppid)).map((p) => p.pid);
        killWindowsPostgres(stragglers);
      }
    }
    // On Windows, orphaned postgres workers can keep the child's stdio pipes open after stop(), which stops Node from exiting.
    for (const s of [child?.stdin, child?.stdout, child?.stderr]) s?.destroy();
    child?.unref();
    if (ephemeral) {
      // Windows can keep files locked briefly after the server stops; retry, and never fail a run over a temp dir.
      try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* leftover temp dir is harmless */ }
    }
  };
  return { pool, close, kind: ephemeral ? 'ephemeral' : 'embedded' };
}
