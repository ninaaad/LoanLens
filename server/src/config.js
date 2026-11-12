import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');

export const config = {
  root: ROOT,
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || null,
  embeddedPort: Number(process.env.EMBEDDED_PG_PORT || 54330),
  dataDir: process.env.LOANLENS_DATA_DIR || path.join(ROOT, '.data', 'pg'),
  // Shrinks simulated provider latency so the demo is snappy. Recorded latency stays nominal.
  latencyScale: Number(process.env.LATENCY_SCALE ?? 0.02),
  rbiPdf: path.join(ROOT, 'data', 'rbi', 'rbi_digital_lending_directions_2025.pdf'),
  llmProvider: process.env.LLM_PROVIDER || 'none',
};
