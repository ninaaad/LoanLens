import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { mockRouter } from './mock/routes.js';
import { journeyRouter } from './journey/routes.js';
import { analyticsRouter } from './analytics/routes.js';
import { ragRouter } from './rag/routes.js';
import { mockControlRouter } from './mock/controls.js';
import { experimentsRouter } from './experiments/routes.js';
import { HttpError } from './journey/service.js';

export function createApp({ pool, extraRoutes = [] }) {
  const app = express();
  app.disable('x-powered-by');
  // Basic hardening headers. No CSP here: the dev server and Recharts use inline styles, and a wrong CSP breaks the page silently.
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });
  app.locals.pool = pool;
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', async (_req, res) => {
    const { rows } = await pool.query('select 1 as ok');
    res.json({ ok: rows[0].ok === 1 });
  });
  app.use('/mock', mockRouter());
  app.use('/api', journeyRouter(pool));
  app.use('/api', analyticsRouter(pool));
  app.use('/api/compliance', ragRouter(pool));
  app.use('/api/mock', mockControlRouter(pool));
  app.use('/api/experiments', experimentsRouter(pool));
  for (const [prefix, router] of extraRoutes) app.use(prefix, router);

  // unknown API paths are JSON, never the HTML page or Express's default
  app.use(['/api', '/mock'], (req, res) => res.status(404).json({ error: `no such endpoint: ${req.method} ${req.baseUrl}${req.path}`.slice(0, 200) }));

  const dist = path.join(config.root, 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    // the app shell is for page routes only: a missing file (a path with an extension) is a real 404, not an HTML page served as a script
    app.get(/^\/(?!api|mock)[^.]*$/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
    app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));
  }

  app.use(errorHandler);
  return app;
}

/**
 * One error shape for every route: { error: "message" } (plus { errors: [...] } when there are several reasons).
 * Messages from HttpError and from the body parser are written for clients. Anything else is logged on the server only
 * and the client gets a generic message, so stack traces, SQL and file paths never leave the process.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err);
  let status = 500;
  let message = 'internal server error';
  if (err instanceof HttpError) {
    status = err.status;
    message = err.message;
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    message = 'request body is not valid JSON';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    message = 'request body is too large';
  } else if (err?.code === '23505') {
    status = 409;
    message = 'that record already exists';
  } else if (typeof err?.code === 'string' && err.code.startsWith('22')) {
    status = 400; // Postgres data exceptions: a value is malformed or out of range
    message = 'a value in the request is malformed or out of range';
  }
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message, ...(err instanceof HttpError && err.details ? { errors: err.details } : {}) });
}
