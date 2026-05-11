// src/providers/streams.ts
import { Stream, StreamMeta, HttpStream } from '../types';
import { cacheGet, cacheSet, CacheKeys } from '../cache/redis';
import { searchJackett } from '../jackett';
import { resolveDebrid } from '../torbox';
import { getHttpFallbackStreams } from '../http-fallback';
import { buildStreamTitle } from '../utils/quality';
import { logger } from '../utils/logger';

const STREAM_SOFT_TTL = parseInt(process.env.CACHE_TTL_STREAMS || '1800');
const STREAM_HARD_TTL = STREAM_SOFT_TTL * 4; // Keep in Redis 4x longer than soft TTL

// Tracks in-flight background refreshes so we don't pile them up
const refreshing = new Set<string>();

/**
 * Convert debrid + HTTP results into Stremio Stream objects.
 */
function buildStreams(
  debridResults: Awaited<ReturnType<typeof resolveDebrid>>,
  httpStreams: HttpStream[]
): Stream[] {
  const streams: Stream[] = [];

  // 1. Debrid streams (best quality, fastest)
  for (const result of debridResults) {
    if (!result.cached || !result.streamUrl) continue;
    const { torrent } = result;

    streams.push({
      name: `[TorBox] ${torrent.quality}${torrent.dolbyVision ? ' DV' : torrent.hdr ? ' HDR' : ''}`,
      title: buildStreamTitle(
        torrent.quality,
        torrent.size,
        torrent.seeders,
        torrent.source,
        torrent.hdr || false,
        torrent.dolbyVision || false
      ),
      url: result.streamUrl,
      behaviorHints: { bingeGroup: `torbox-${torrent.quality}` },
    });
  }

  // 2. HTTP fallback streams
  for (const http of httpStreams) {
    streams.push({
      name: `[HTTP] ${http.name}`,
      title: `${http.quality} · ${http.source}`,
      url: http.url,
      behaviorHints: {
        notWebReady: false,
        proxyHeaders: http.headers ? { request: http.headers } : undefined,
      },
    });
  }

  return streams;
}

/**
 * Fetch fresh streams from all providers (Jackett → TorBox + HTTP fallback).
 */
async function fetchFreshStreams(meta: StreamMeta): Promise<Stream[]> {
  const { imdbId, type, season, episode } = meta;

  // Run Jackett + HTTP fallback in parallel
  const [torrents, httpStreams] = await Promise.all([
    searchJackett(imdbId, type, season, episode),
    getHttpFallbackStreams(imdbId, season, episode),
  ]);

  // Resolve torrents through TorBox
  const debridResults = await resolveDebrid(torrents, season, episode);

  const streams = buildStreams(debridResults, httpStreams);
  logger.info(`Fetched ${streams.length} streams for ${imdbId}`, {
    debrid: debridResults.filter((r) => r.cached).length,
    http: httpStreams.length,
  });

  return streams;
}

/**
 * Background refresh: fetch and cache without blocking the current request.
 */
function backgroundRefresh(meta: StreamMeta, cacheKey: string): void {
  if (refreshing.has(cacheKey)) return;
  refreshing.add(cacheKey);

  fetchFreshStreams(meta)
    .then((streams) => cacheSet(cacheKey, streams, STREAM_HARD_TTL))
    .catch((err) => logger.error('Background refresh failed', { cacheKey, err: err.message }))
    .finally(() => refreshing.delete(cacheKey));
}

/**
 * Main entry point: get streams for a piece of content.
 *
 * Strategy:
 * 1. Check Redis cache.
 *    - Fresh hit → return immediately (< 50ms)
 *    - Stale hit → return immediately + trigger background refresh
 *    - Miss → fetch HTTP fallback immediately (fast), trigger full background fetch
 * 2. On next request after background refresh → full debrid streams served instantly.
 */
export async function getStreams(meta: StreamMeta): Promise<Stream[]> {
  const { imdbId, season, episode } = meta;
  const cacheKey = CacheKeys.streams(imdbId, season, episode);

  const { value: cached, stale } = await cacheGet<Stream[]>(cacheKey, STREAM_SOFT_TTL, STREAM_HARD_TTL);

  if (cached !== null) {
    if (stale) {
      logger.debug('Serving stale cache, refreshing in background', { cacheKey });
      backgroundRefresh(meta, cacheKey);
    }
    return cached;
  }

  // Cache miss — serve HTTP fallback streams immediately for responsiveness
  logger.info('Cache miss, fetching HTTP fallback immediately', { imdbId });
  const httpStreams = await getHttpFallbackStreams(imdbId, season, episode);
  const immediateStreams = httpStreams.map((http): Stream => ({
    name: `[HTTP] ${http.name}`,
    title: `${http.quality} · ${http.source}`,
    url: http.url,
    behaviorHints: {
      notWebReady: false,
      proxyHeaders: http.headers ? { request: http.headers } : undefined,
    },
  }));

  // Trigger full fetch (Jackett + TorBox) in background; next request will be instant
  backgroundRefresh(meta, cacheKey);

  return immediateStreams;
}
