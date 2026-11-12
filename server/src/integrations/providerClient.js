import { config } from '../config.js';

let baseUrl = null;
export const setMockBaseUrl = (u) => { baseUrl = u; };

const PATHS = { bureau: '/mock/bureau/score', kyc: '/mock/kyc/verify' };

/**
 * Call a provider with a timeout, one retry on 5xx/timeout (same idempotency key), and a typed result.
 * Never throws: the journey decides what to do when a provider fails (bureau failure -> refer).
 * Wall-clock timeouts are shrunk by LATENCY_SCALE together with the simulated latency.
 */
export async function callProvider(provider, body, { timeoutMs = 6000, retries = 1, idempotencyKey } = {}) {
  let last = 'error';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(50, timeoutMs * config.latencyScale));
    try {
      const res = await fetch(baseUrl + PATHS[provider], {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status >= 500 || res.status === 429) { last = res.status === 429 ? 'rate_limited' : 'error'; continue; }
      const data = await res.json();
      return { ok: true, status: 'ok', data, latency_ms: data.latency_ms, attempts: attempt + 1 };
    } catch (e) {
      clearTimeout(timer);
      last = e.name === 'AbortError' ? 'timeout' : 'error';
    }
  }
  return { ok: false, status: last, data: null, latency_ms: timeoutMs, attempts: retries + 1 };
}
