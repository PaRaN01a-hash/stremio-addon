// src/providers/streams.ts
import { Stream, StreamMeta, HttpStream } from '../types';
import { cacheGet, cacheSet, CacheKeys } from '../cache/redis';
import { searchJackett } from '../jackett';
import { searchZilean } from '../zilean';
import { resolveDebrid } from '../torbox';
import { getHttpFallbackStreams } from '../http-fallback';
import { buildStreamTitle } from '../utils/quality';
import { logger } from '../utils/logger';
import { getExternalAddonStreams } from './external-addons';

const STREAM_SOFT_TTL = parseInt(process.env.CACHE_TTL_STREAMS || '1800');
const STREAM_HARD_TTL = STREAM_SOFT_TTL * 4; // Keep in Redis 4x longer than soft TTL

function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || 'http://localhost:6000').replace(/\/$/, '');
}

function lazyTorBoxUrl(hash: string, season?: number, episode?: number): string {
  const url = new URL('/resolve', publicBaseUrl());
  url.searchParams.set('hash', hash);
  if (season !== undefined) url.searchParams.set('season', String(season));
  if (episode !== undefined) url.searchParams.set('episode', String(episode));
  return url.toString();
}

// Tracks in-flight background refreshes so we don't pile them up
const refreshing = new Set<string>();

function extractHash(stream: Stream): string | null {
  const haystack = [
    stream.url || '',
    stream.name || '',
    stream.title || '',
    (stream as any).description || '',
    stream.behaviorHints?.bingeGroup || '',
    (stream.behaviorHints as any)?.filename || '',
  ].join(' ');

  const match = haystack.match(/([a-f0-9]{40})/i);
  return match ? match[1].toLowerCase() : null;
}

function qualityScore(stream: Stream): number {
  const text = `${stream.name} ${stream.title}`.toLowerCase();
  let score = 0;

  if (text.includes('4k') || text.includes('2160')) score += 400;
  else if (text.includes('1080')) score += 250;
  else if (text.includes('720')) score += 100;

  if (text.includes('hdr')) score += 40;
  if (text.includes('dv')) score -= 50;
  if (text.includes('remux')) score -= 100;

  const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*gb/i);
  if (sizeMatch) {
    const gb = parseFloat(sizeMatch[1]);
    if (gb >= 2 && gb <= 12) score += 60;
    if (gb > 30) score -= 150;
    else if (gb > 20) score -= 80;
  }

  return score;
}

function cleanStreams(streams: Stream[]): Stream[] {
  const seen = new Set<string>();

  const deduped = streams.filter((stream) => {
    const text = `${stream.name || ''} ${stream.title || ''} ${String((stream as any).description || '')}`.toLowerCase();

    // Remove utility/control streams that are not actual playable media
    if (
      text.includes('sync debrid') ||
      text.includes('comet sync') ||
      text.includes('debrid-sync') ||
      text.includes('debrid account library') ||
      text.includes('select this stream') ||
      String(stream.url || '').includes('/debrid-sync/')
    ) {
      return false;
    }

    const hash = extractHash(stream);
    const key = hash || `${stream.name}|${stream.title}|${stream.url}`;

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped
    .filter((stream) => {
      const text = [
        stream.name || '',
        stream.title || '',
        String((stream as any).description || ''),
        stream.url || '',
      ].join(' ').toLowerCase();

      return !(
        text.includes('comet sync') ||
        text.includes('sync debrid') ||
        text.includes('debrid-sync') ||
        text.includes('debrid account library') ||
        text.includes('select this stream')
      );
    })
    .sort((a, b) => qualityScore(b) - qualityScore(a))
    .slice(0, 25);
}


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
    if (!result.cached) continue;
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
      url: lazyTorBoxUrl(torrent.infoHash),
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

  return cleanStreams(streams);
}

/**
 * Fetch fresh streams from all providers (Jackett → TorBox + HTTP fallback).
 */
async function fetchFreshStreams(meta: StreamMeta): Promise<Stream[]> {
  const { imdbId, type, season, episode } = meta;

  // Run internal providers + bridged addons in parallel
  const [zileanTorrents, jackettTorrents, httpStreams, externalStreams] = await Promise.all([
    searchZilean(meta),
    searchJackett(imdbId, type, season, episode),
    getHttpFallbackStreams(imdbId, season, episode),
    getExternalAddonStreams(meta),
  ]);

  // Zilean/DMM first, Jackett as fallback. Dedup by infoHash before TorBox check.
  const seenHashes = new Set<string>();
  const torrents = [...zileanTorrents, ...jackettTorrents].filter((torrent) => {
    const hash = torrent.infoHash?.toLowerCase();
    if (!hash || seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    return true;
  });

  // Resolve torrents through TorBox
  const debridResults = await resolveDebrid(torrents, season, episode);

  const streams = [...buildStreams(debridResults, httpStreams), ...externalStreams];
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

  // Cache miss — fetch full lazy TorBox stream list now.
  // This is slower on the first request, but avoids returning an empty list.
  logger.info('Cache miss, fetching fresh lazy streams', { imdbId });
  const freshStreams = await fetchFreshStreams(meta);
  if (freshStreams.length > 0) {
    await cacheSet(cacheKey, freshStreams, STREAM_HARD_TTL);
  }
  return freshStreams;
}
