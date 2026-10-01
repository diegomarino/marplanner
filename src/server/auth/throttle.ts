import type { FastifyInstance, FastifyReply } from "fastify";

const POLICIES = {
  api: { threshold: 20, windowMs: 60_000 },
  bootstrap: { threshold: 5, windowMs: 600_000 },
};
type Flow = keyof typeof POLICIES;
const QUIET_MS = 15 * 60_000;
const MAX_ENTRIES = 5000;
interface FailureBucket {
  windowStart: number;
  count: number;
  lastFailure: number;
  until: number;
  delay: number;
}

function normalizeSource(source: string): string {
  if (!source.includes(":")) return source;
  // The URL parser canonicalizes IPv6, including dotted IPv4-mapped addresses.
  const [host, zone] = source.split("%");
  const address = new URL(`http://[${host}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(address);
  if (!mapped) return zone ? `${address}%${zone}` : address;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

class AuthenticationBackoff {
  // ponytail: process-local counters reset on restart/eviction; shared storage if multi-process protection is needed.
  private readonly buckets = new Map<string, FailureBucket>();

  failure(flow: Flow, source: string): number {
    const now = Date.now();
    // Map order is least-recently failed first, so pruning stops at the first live entry.
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastFailure < QUIET_MS) break;
      this.buckets.delete(key);
    }
    const key = `${flow}:${normalizeSource(source)}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= MAX_ENTRIES) {
        this.buckets.delete(this.buckets.keys().next().value!);
      }
      bucket = { windowStart: now, count: 0, lastFailure: now, until: 0, delay: 0 };
    }
    bucket.lastFailure = now;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (now < bucket.until) return Math.ceil((bucket.until - now) / 1000);
    if (bucket.delay === 0) {
      const policy = POLICIES[flow];
      if (now - bucket.windowStart >= policy.windowMs) {
        bucket.windowStart = now;
        bucket.count = 0;
      }
      bucket.count += 1;
      if (bucket.count < policy.threshold) return 0;
    }
    bucket.delay = Math.min(bucket.delay ? bucket.delay * 2 : 1, 60);
    bucket.until = now + bucket.delay * 1000;
    return bucket.delay;
  }
}

const byApp = new WeakMap<FastifyInstance, AuthenticationBackoff>();
export function authenticationBackoff(app: FastifyInstance): AuthenticationBackoff {
  let backoff = byApp.get(app);
  if (!backoff) {
    backoff = new AuthenticationBackoff();
    byApp.set(app, backoff);
  }
  return backoff;
}

export function sendAuthenticationBackoff(reply: FastifyReply, seconds: number): FastifyReply {
  return reply.code(429).header("Retry-After", seconds).header("Cache-Control", "no-store").send({
    error: "too_many_requests",
    message: "Authentication retry required",
  });
}
