/**
 * Tiny in-memory fixed-window rate limiter for the read-only lookup routes.
 *
 * This is per server process, so it is a guard against a runaway client or a
 * casual scraper rather than a distributed defence. It keeps the counter map
 * bounded so it cannot grow without limit.
 */

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();
const MAX_TRACKED_CLIENTS = 5_000;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window rolls over. */
  retryAfter: number;
};

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    if (windows.size >= MAX_TRACKED_CLIENTS) sweep(now);
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }

  existing.count++;
  const retryAfter = Math.ceil((existing.resetAt - now) / 1000);

  if (existing.count > limit) {
    return { allowed: false, remaining: 0, retryAfter };
  }

  return { allowed: true, remaining: limit - existing.count, retryAfter };
}

function sweep(now: number) {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
  // Everything is still live: drop the map rather than leak memory.
  if (windows.size >= MAX_TRACKED_CLIENTS) windows.clear();
}

/**
 * Best-effort client identity. Behind a proxy we trust `x-forwarded-for`
 * only for bucketing requests, never for authorisation.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip");
  return ip?.slice(0, 64) || "unknown";
}
