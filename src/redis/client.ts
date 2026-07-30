/**
 * @module    redis-client
 * @layer     TRANSPORT
 * @inherits  ROOT
 * @mai       N/A
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * Shared Redis client with graceful degradation.
 * If Redis is unavailable, all operations return null/false silently.
 * The MCP server NEVER goes down because the cache layer failed.
 */

import Redis from 'ioredis';
import { randomUUID } from 'crypto';

let _redis: Redis | null = null;
let _connected = false;

export function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (_redis) return _connected ? _redis : null;

  _redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: 3000,
    commandTimeout: 1000,
    retryStrategy: (times: number) => {
      if (times > 10) {
        // Stop retrying after 10 attempts — stay in graceful-degraded mode
        // The error event will have already logged the failure
        return null;
      }
      return Math.min(times * 200, 3_000);
    },
  });

  let _loggedDisconnect = false;

  _redis.on('ready', () => {
    _connected = true;
    _loggedDisconnect = false; // Reset so next disconnect is logged
    console.error('[GIA-Redis] INFO: Redis connected');
  });

  _redis.on('error', (err: Error) => {
    _connected = false;
    if (!_loggedDisconnect) {
      _loggedDisconnect = true;
      console.error(`[GIA-Redis] WARN: Redis unavailable — falling back to in-memory: ${err.message}`);
    }
  });

  _redis.on('reconnecting', () => {
    console.error('[GIA-Redis] DEBUG: Redis reconnecting...');
  });

  _redis.connect().catch(() => {
    // Silently handled by error event above
  });

  return null; // Return null on first call — ready event will flip _connected
}

/**
 * SET key value EX seconds NX (set if not exists with TTL).
 * Returns true if the key was set (not already present), false otherwise.
 * Falls back to false if Redis is unavailable.
 */
export async function redisSetNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  try {
    const result = await r.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch {
    return false;
  }
}

/**
 * Sliding window rate limit check using Redis sorted sets.
 * Returns { allowed: boolean, count: number }.
 * Falls back to { allowed: true, count: 0 } if Redis unavailable (in-memory limiter handles it).
 */
export async function redisSlidingWindow(
  key: string,
  windowMs: number,
  maxRequests: number,
): Promise<{ allowed: boolean; count: number }> {
  const r = getRedis();
  if (!r) return { allowed: true, count: 0 };

  const now = Date.now();
  const windowStart = now - windowMs;
  const member = `${now}-${randomUUID()}`;

  try {
    // Step 1: Remove expired entries and get pre-add count in one pipeline
    const checkPipeline = r.pipeline();
    checkPipeline.zremrangebyscore(key, '-inf', windowStart);
    checkPipeline.zcard(key);
    const checkResults = await checkPipeline.exec();

    const currentCount = (checkResults?.[1]?.[1] as number) ?? 0;

    // Step 2: Check BEFORE adding — denied requests do not consume a slot
    if (currentCount >= maxRequests) {
      return { allowed: false, count: currentCount };
    }

    // Step 3: Allowed — add to window and refresh TTL
    const addPipeline = r.pipeline();
    addPipeline.zadd(key, now, member);
    addPipeline.pexpire(key, windowMs);
    await addPipeline.exec();

    return { allowed: true, count: currentCount + 1 };
  } catch {
    return { allowed: true, count: 0 };
  }
}

/**
 * GET a string value from Redis.
 * Returns null if key missing or Redis unavailable.
 */
export async function redisGet(key: string): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(key);
  } catch {
    return null;
  }
}

/**
 * SET key value EX seconds.
 * Returns true on success, false if Redis unavailable.
 */
export async function redisSet(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  try {
    await r.set(key, value, 'EX', ttlSeconds);
    return true;
  } catch {
    return false;
  }
}
