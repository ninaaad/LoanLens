import express from 'express';
import { config } from '../config.js';
import { mockState, resetMock } from './state.js';
import { mulberry32, hashString, gauss, clamp } from './random.js';
import { tokenBucket } from './rateLimit.js';
import { applyPatch } from './controls.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lognormal = (s) => s.baseMs * s.multiplier * Math.exp(s.sigma * gauss(Math.random));

export function mockRouter() {
  const router = express.Router();
  const cache = new Map(); // Idempotency-Key -> response body
  router.use(tokenBucket({ capacity: 500, refillPerSec: 250 }));

  async function simulate(s, res, handler, req) {
    const key = req.get('Idempotency-Key');
    if (key && cache.has(key)) return res.json(cache.get(key));
    const latency = lognormal(s);
    await sleep(latency * config.latencyScale);
    if (Math.random() < s.timeoutRate) {
      await sleep(30000 * config.latencyScale); // long enough that the client gives up first
      return res.status(504).json({ error: 'timeout' });
    }
    if (Math.random() < s.errorRate) return res.status(503).json({ error: 'unavailable' });
    const body = { ...handler(), latency_ms: Math.round(latency) };
    if (key) cache.set(key, body);
    res.json(body);
  }

  router.post('/bureau/score', (req, res) =>
    simulate(mockState.bureau, res, () => {
      const { applicant_ref = 'x', new_to_credit = false } = req.body ?? {};
      if (mockState.bureau.forceScore != null) return { score: mockState.bureau.forceScore };
      const rng = mulberry32(hashString(String(applicant_ref)));
      const score = new_to_credit ? 690 + 45 * gauss(rng) : 715 + 60 * gauss(rng);
      return { score: Math.round(clamp(score, 300, 900)) };
    }, req));

  router.post('/kyc/verify', (req, res) =>
    simulate(mockState.kyc, res, () => {
      if (mockState.kyc.forceVerified != null) return { verified: mockState.kyc.forceVerified };
      const rng = mulberry32(hashString(`kyc-${req.body?.applicant_ref ?? 'x'}`));
      return { verified: rng() < 0.96 };
    }, req));

  router.get('/config', (_req, res) => res.json(mockState));
  // validated patch (same rules as /api/mock/config); a bad value is a 400 and changes nothing
  router.post('/config', (req, res, next) => {
    try {
      const { provider, ...patch } = req.body ?? {};
      res.json(applyPatch(provider, patch));
    } catch (e) { next(e); }
  });
  router.post('/reset', (_req, res) => { resetMock(); res.json(mockState); });
  return router;
}
