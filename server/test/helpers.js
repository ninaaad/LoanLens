import { createDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { ensureDefaultRules } from '../src/rules/defaultRules.js';
import { createApp } from '../src/app.js';
import { setMockBaseUrl } from '../src/integrations/providerClient.js';
import { config } from '../src/config.js';
import { resetMock } from '../src/mock/state.js';

export async function boot({ extraRoutes } = {}) {
  config.latencyScale = 0.002;
  resetMock();
  const db = await createDb({ ephemeral: true });
  await migrate(db.pool);
  await ensureDefaultRules(db.pool);
  const app = createApp({ pool: db.pool, extraRoutes: extraRoutes ? extraRoutes(db.pool) : [] });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  setMockBaseUrl(base);
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const close = async () => { await new Promise((r) => server.close(r)); await db.close(); };
  return { pool: db.pool, base, call, close };
}

export const applicant = {
  age: 34, monthly_income: 60000, existing_emi: 5000, employment: 'salaried',
  requested_amount: 300000, tenure_months: 36, channel: 'organic', device: 'android', app_version: '2.2',
};
