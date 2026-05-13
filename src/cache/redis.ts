// src/cache/redis.ts
import Redis from 'ioredis';

const REDIS_DISABLED = process.env.REDIS_DISABLED === 'true' || process.env.REDIS_DISABLED === '1';
import { logger } from '../utils/logger';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (REDIS_DISABLED) {
    throw new Error('Redis disabled');
  }
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    client.on('error', (err) => logger.error('Redis error', { err: err.message }));
    client.on('connect', () => logger.info('Redis connected'));
  }
  return client;
}

/**
 * Get a cached value. Returns { value, stale } where stale=true means
 * the value exists but is past its soft TTL (should be refreshed in background).
 */
export async function cacheGet<T>(
  key: string,
  softTtl: number,         // seconds — after this, data is "stale" but still served
  hardTtl?: number         // seconds — after this, Redis evicts the key entirely
): Promise<{ value: T | null; stale: boolean }> {
  if (REDIS_DISABLED) return { value: null, stale: false };

  try {
    const redis = getRedis();
    const raw = await redis.get(key);
    if (!raw) return { value: null, stale: false };

    const entry = JSON.parse(raw) as { data: T; cachedAt: number };
    const age = (Date.now() - entry.cachedAt) / 1000;
    const stale = age > softTtl;

    return { value: entry.data, stale };
  } catch (err) {
    logger.warn('Cache get failed', { key, err });
    return { value: null, stale: false };
  }
}

export async function cacheSet<T>(
  key: string,
  data: T,
  hardTtl: number          // seconds — Redis key expiry
): Promise<void> {
  if (REDIS_DISABLED) return;

  try {
    const redis = getRedis();
    const entry = { data, cachedAt: Date.now() };
    await redis.set(key, JSON.stringify(entry), 'EX', hardTtl);
  } catch (err) {
    logger.warn('Cache set failed', { key, err });
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    if (REDIS_DISABLED) return;
    await getRedis().del(key);
  } catch (err) {
    logger.warn('Cache delete failed', { key, err });
  }
}

export async function cacheScan(pattern: string): Promise<string[]> {
  if (REDIS_DISABLED) return [];
  const redis = getRedis();
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...found);
  } while (cursor !== '0');
  return keys;
}

// Cache key helpers
export const CacheKeys = {
  streams: (imdbId: string, season?: number, episode?: number) =>
    season !== undefined
      ? `streams:${imdbId}:${season}:${episode}`
      : `streams:${imdbId}`,

  torrents: (imdbId: string, season?: number, episode?: number) =>
    season !== undefined
      ? `torrents:${imdbId}:${season}:${episode}`
      : `torrents:${imdbId}`,

  debridAvailability: (infoHash: string) => `debrid:avail:${infoHash}`,

  httpStreams: (imdbId: string, season?: number, episode?: number) =>
    season !== undefined
      ? `http:${imdbId}:${season}:${episode}`
      : `http:${imdbId}`,
};
