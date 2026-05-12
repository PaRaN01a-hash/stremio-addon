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

function streamText(stream: Stream): string {
  const anyStream = stream as any;
  return [
    stream.name || '',
    stream.title || '',
    anyStream.description || '',
    anyStream.behaviorHints?.filename || '',
    stream.url || '',
  ].join(' ').toLowerCase();
}

function streamSize(stream: Stream): number {
  const anyStream = stream as any;
  return Number(anyStream.behaviorHints?.videoSize || 0);
}

function streamKey(stream: Stream): string {
  const anyStream = stream as any;
  const text = streamText(stream);
  const binge = anyStream.behaviorHints?.bingeGroup || '';
  const filename = anyStream.behaviorHints?.filename || '';
  const hashMatch = `${binge} ${stream.url || ''}`.match(/[a-f0-9]{40}/i);

  if (hashMatch) return `hash:${hashMatch[0].toLowerCase()}`;
  if (filename) return `file:${String(filename).toLowerCase().replace(/[^a-z0-9]+/g, '')}`;

  const size = streamSize(stream);
  if (size > 0) return `name:${text.replace(/[^a-z0-9]+/g, '')}:size:${Math.round(size / 50000000)}`;

  return `url:${stream.url || text}`;
}

function scoreStream(stream: Stream): number {
  const text = streamText(stream);
  const size = streamSize(stream);
  let score = 0;

  if (text.includes('[torbox]')) score += 1000;
  if (text.includes('zilean-dmm')) score += 450;
  if (text.includes('comet')) score += 250;
  if (text.includes('hdhub')) score += 80;

  if (text.includes('2160p') || text.includes('4k')) score += 180;
  if (text.includes('1080p')) score += 160;
  if (text.includes('720p')) score += 90;

  if (text.includes('web-dl')) score += 120;
  if (text.includes('web')) score += 70;
  if (text.includes('bluray') || text.includes('blu-ray')) score += 90;

  if (text.includes('hevc') || text.includes('x265')) score += 80;
  if (text.includes('h 265') || text.includes('h265')) score += 70;
  if (text.includes('avc') || text.includes('x264') || text.includes('h264') || text.includes('h 264')) score += 35;

  if (text.includes('hdr')) score += 35;
  if (text.includes('truehd')) score += 25;
  if (text.includes('ddp') || text.includes('dolby digital plus')) score += 20;

  if (text.includes('cam') || text.includes('hdcam') || text.includes('ts ') || text.includes('telesync')) score -= 1000;
  if (text.includes('scr') || text.includes('screener')) score -= 500;
  if (text.includes('dv') || text.includes('dovi') || text.includes('dolby vision')) score -= 80;
  if (text.includes('remux')) score -= 120;

  // Keep sizes sane. Reward useful sweet spots, punish monsters and tiny junk.
  const gb = size / 1024 / 1024 / 1024;
  if (gb > 0) {
    const is4k = text.includes('2160p') || text.includes('4k');
    const is1080 = text.includes('1080p');
    const is720 = text.includes('720p');

    if (is4k) {
      if (gb >= 5 && gb <= 12) score += 180;
      else if (gb > 12 && gb <= 18) score += 60;
      else if (gb > 18) score -= 250;
      else if (gb < 3) score -= 120;
    } else if (is1080) {
      if (gb >= 1.5 && gb <= 6) score += 180;
      else if (gb > 6 && gb <= 10) score += 60;
      else if (gb > 10) score -= 220;
      else if (gb < 1) score -= 90;
    } else if (is720) {
      if (gb >= 0.6 && gb <= 3) score += 140;
      else if (gb > 5) score -= 180;
      else if (gb < 0.35) score -= 120;
    } else {
      if (gb >= 1 && gb <= 8) score += 80;
      else if (gb > 20) score -= 250;
      else if (gb < 0.35) score -= 200;
    }
  }

  const seedMatch = text.match(/👥\s*(\d+)/);
  if (seedMatch) score += Math.min(Number(seedMatch[1] || 0), 200);

  return score;
}

function cleanStreams(streams: Stream[]): Stream[] {
  const blocked = streams.filter((stream) => {
    const text = streamText(stream);
    return !(
      text.includes('comet sync') ||
      text.includes('debrid-sync') ||
      String(stream.url || '').includes('/debrid-sync/')
    );
  });

  const byKey = new Map<string, Stream>();

  for (const stream of blocked) {
    const key = streamKey(stream);
    const existing = byKey.get(key);

    if (!existing || scoreStream(stream) > scoreStream(existing)) {
      byKey.set(key, stream);
    }
  }

  return [...byKey.values()]
    .sort((a, b) => scoreStream(b) - scoreStream(a))
    .slice(0, parseInt(process.env.MAX_FINAL_STREAMS || '25'));
}



// Tracks in-flight background refreshes so we don't pile them up
const refreshing = new Set<string>();

function msSince(start: number): number {
  return Date.now() - start;
}



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



/**
 * Convert debrid + HTTP results into Stremio Stream objects.
 */
function buildStreams(
  debridResults: Awaited<ReturnType<typeof resolveDebrid>>,
  httpStreams: HttpStream[],
  season?: number,
  episode?: number
): Stream[] {
  const streams: Stream[] = [];

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
      url: lazyTorBoxUrl(torrent.infoHash, season, episode),
      behaviorHints: { bingeGroup: `torbox-${torrent.quality}` },
    });
  }

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
  const started = Date.now();
  const { imdbId, type, season, episode } = meta;

  // Run internal providers + bridged addons in parallel
  // Fast path: do NOT wait for external addons on cold load.
  // Zilean/TorBox returns first; Comet/HDHub can be added by background refresh.
  const providerStart = Date.now();
  const [zileanTorrents, httpStreams] = await Promise.all([
    searchZilean(meta),
    getHttpFallbackStreams(imdbId, season, episode),
  ]);
  logger.info('Provider fast path complete', {
    imdbId,
    ms: msSince(providerStart),
    zilean: zileanTorrents.length,
    http: httpStreams.length,
  });

  const minZilean = parseInt(process.env.ZILEAN_MIN_RESULTS_BEFORE_JACKETT || '20');
  const jackettTorrents = zileanTorrents.length >= minZilean
    ? []
    : await searchJackett(imdbId, type, season, episode);

  // Zilean/DMM first, Jackett only if Zilean is weak. Dedup by infoHash before TorBox check.
  const seenHashes = new Set<string>();
  const torrents = [...zileanTorrents, ...jackettTorrents].filter((torrent) => {
    const hash = torrent.infoHash?.toLowerCase();
    if (!hash || seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    return true;
  });

  // Resolve torrents through TorBox
  const torboxStart = Date.now();
  const debridResults = await resolveDebrid(torrents, season, episode);
  logger.info('TorBox resolveDebrid complete', {
    imdbId,
    ms: msSince(torboxStart),
    torrents: torrents.length,
    cached: debridResults.filter((r) => r.cached).length,
  });

  const streams = cleanStreams(buildStreams(debridResults, httpStreams, season, episode));
  logger.info(`Fetched ${streams.length} streams for ${imdbId}`, {
    debrid: debridResults.filter((r) => r.cached).length,
    http: httpStreams.length,
    totalMs: msSince(started),
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

function backgroundExternalRefresh(meta: StreamMeta, cacheKey: string, baseStreams: Stream[]): void {
  getExternalAddonStreams(meta)
    .then(async (externalStreams) => {
      if (!externalStreams.length) return;
      const merged = cleanStreams([...baseStreams, ...externalStreams]);
      await cacheSet(cacheKey, merged, STREAM_HARD_TTL);
      logger.info(`Background external streams added: ${externalStreams.length}`, { cacheKey });
    })
    .catch((err) => logger.warn('Background external refresh failed', { cacheKey, err: err.message }));
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
    logger.info('Stream cache hit', { cacheKey, stale, count: cached.length });
    if (stale) {
      logger.debug('Serving stale cache, refreshing in background', { cacheKey });
      backgroundRefresh(meta, cacheKey);
    }
    return cleanStreams(cached);
  }

  // Cache miss — fetch full lazy TorBox stream list now.
  // This is slower on the first request, but avoids returning an empty list.
  logger.info('Cache miss, fetching fresh lazy streams', { imdbId });
  const freshStreams = await fetchFreshStreams(meta);
  if (freshStreams.length > 0) {
    await cacheSet(cacheKey, freshStreams, STREAM_HARD_TTL);
    backgroundExternalRefresh(meta, cacheKey, freshStreams);
  }
  return freshStreams;
}
