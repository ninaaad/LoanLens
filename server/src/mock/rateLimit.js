// STAND-IN token bucket used in front of the mock provider endpoints.
// It is deliberately small and is NOT the standalone Rate Limiter project.
export function tokenBucket({ capacity = 200, refillPerSec = 100, keyFn = (req) => req.ip } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: capacity, last: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
    b.last = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      res.set('Retry-After', '1');
      return res.status(429).json({ error: 'rate_limited' });
    }
    b.tokens -= 1;
    buckets.set(key, b);
    next();
  };
}
