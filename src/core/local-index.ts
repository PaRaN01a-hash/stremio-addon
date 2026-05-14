import type { Stream, StreamMeta } from '../types';
import { cacheDelete, cacheGet, cacheSet } from '../cache/redis';
import { scoreStreamCandidate } from './candidate-match';
import { candidateSortScore, bucketCandidate } from './candidate-sort';
import { logger } from '../utils/logger';

const LOCAL_INDEX_TTL = parseInt(process.env.LOCAL_INDEX_TTL || String(60 * 60 * 24 * 30), 10);

export interface LocalIndexedStream {
  id: string;
  imdbId: string;
  type: 'movie' | 'series';
  season?: number;
  episode?: number;

  name?: string;
  title?: string;
  filename?: string;
  description?: string;
  url?: string;
  infoHash?: string;
  size?: number;

  matchDecision?: string;
  matchScore?: number;
  sortScore?: number;
  bucket?: string;

  indexedAt: string;
  raw: Stream;
}

export function localIndexKey(meta: StreamMeta): string {
  return meta.season !== undefined
    ? `local:index:streams:${meta.imdbId}:${meta.season}:${meta.episode}`
    : `local:index:streams:${meta.imdbId}`;
}

function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || 'http://localhost:6000').replace(/\/$/, '');
}

function normalizeInfoHash(input: unknown): string | undefined {
  const value = String(input || '').trim();
  if (!value) return undefined;

  const btih = value.match(/btih:([a-f0-9]{40})/i);
  if (btih?.[1]) return btih[1].toLowerCase();

  const hex = value.match(/\b[a-f0-9]{40}\b/i);
  if (hex?.[0]) return hex[0].toLowerCase();

  return undefined;
}

function lazyResolveUrlFromHash(infoHashInput: unknown, meta: StreamMeta): string | undefined {
  const infoHash = normalizeInfoHash(infoHashInput);
  if (!infoHash) return undefined;

  const url = new URL('/resolve', publicBaseUrl());
  url.searchParams.set('hash', infoHash);

  if (meta.season !== undefined) url.searchParams.set('season', String(meta.season));
  if (meta.episode !== undefined) url.searchParams.set('episode', String(meta.episode));

  return url.toString();
}

function streamInfoHash(stream: any): string | undefined {
  return normalizeInfoHash(
    stream?.infoHash ||
    stream?.infohash ||
    stream?.info_hash ||
    stream?.hash ||
    stream?.behaviorHints?.infoHash ||
    stream?.behaviorHints?.infohash ||
    stream?.behaviorHints?.hash ||
    stream?.url ||
    stream?.externalUrl ||
    stream?.title ||
    stream?.name ||
    stream?.description ||
    stream?.behaviorHints?.filename
  );
}

function streamUrlWithInfoHashFallback(stream: any, meta: StreamMeta): string | undefined {
  return stream?.url || lazyResolveUrlFromHash(streamInfoHash(stream), meta);
}

function expectedTitle(meta: StreamMeta, fallbackTitle?: string): string {
  return String(
    fallbackTitle ||
    (meta as any).title ||
    (meta as any).name ||
    ''
  ).trim();
}

function maximusMemoryLabel(stream: any): any {
  return stream?.behaviorHints?.maximus;
}

function isResolverUrl(url?: string): boolean {
  return Boolean(url && /\/resolve\?hash=/i.test(url));
}

function isMemoryEligibleStream(stream: any, scored: any): boolean {
  const label = maximusMemoryLabel(stream);
  const url = scored?.url || stream?.url;

  if (!url) return false;
  if (scored?.match?.decision !== 'accept') return false;

  // If v2.3 labels exist, trust the passport but keep the scored accept/url guard above.
  if (label) {
    return Boolean(label.memoryEligible === true || label.matchDecision === 'accept');
  }

  // Backward compatibility for streams created before labels existed.
  return isResolverUrl(url) || scored?.sourceType === 'cached';
}

export async function saveKnownGoodStreams(
  meta: StreamMeta,
  streams: Stream[],
  fallbackTitle?: string
): Promise<void> {
  if (!streams.length) return;

  const title = expectedTitle(meta, fallbackTitle);
  if (!title) {
    logger.debug('Skipping local index save because expected title is missing', {
      imdbId: meta.imdbId,
      season: meta.season,
      episode: meta.episode,
    });
    return;
  }

  const indexed: LocalIndexedStream[] = streams
    .map((stream: any, index: number) => {
      const streamUrl = streamUrlWithInfoHashFallback(stream, meta);

      const scored = scoreStreamCandidate({
        id: String(streamUrl || stream.behaviorHints?.filename || stream.title || stream.name || index),
        provider: stream.name?.startsWith('[TB+]') ? 'torbox' : 'external-addon',
        sourceType: stream.name?.startsWith('[TB+]') ? 'cached' : 'external',
        name: stream.name,
        title: stream.title,
        filename: stream.behaviorHints?.filename,
        description: stream.description,
        url: streamUrl,
        size: stream.behaviorHints?.videoSize,
        raw: stream,
      }, {
        type: meta.type,
        title,
        season: meta.season,
        episode: meta.episode,
      });

      return {
        id: scored.id,
        imdbId: meta.imdbId,
        type: meta.type,
        season: meta.season,
        episode: meta.episode,
        name: scored.name,
        title: scored.title,
        filename: scored.filename,
        description: scored.description,
        url: scored.url,
        size: scored.size,
        matchDecision: scored.match?.decision,
        matchScore: scored.match?.score,
        sortScore: candidateSortScore(scored),
        bucket: bucketCandidate(scored),
        indexedAt: new Date().toISOString(),
        raw: stream,
      };
    })
    .filter((item) => item.matchDecision === 'accept');

  if (!indexed.length) return;

  await cacheSet(localIndexKey(meta), indexed, LOCAL_INDEX_TTL);

  logger.info('Saved known-good streams to local index', {
    key: localIndexKey(meta),
    count: indexed.length,
  });
}

export async function saveManualKnownGoodStreams(
  meta: StreamMeta,
  streams: Stream[],
  fallbackTitle?: string
): Promise<LocalIndexedStream[]> {
  const title = expectedTitle(meta, fallbackTitle);

  if (!title) {
    throw new Error('manual_index_title_required');
  }

  if (!streams.length) {
    throw new Error('manual_index_streams_required');
  }

  const indexed: LocalIndexedStream[] = streams
    .map((stream: any, index: number) => {
      const manualInfoHash = normalizeInfoHash(stream.infoHash || stream.hash || stream.info_hash || stream.infohash);

        const normalizedStream: Stream = {
        name: stream.name || '[Manual] Stream',
        title: stream.title || stream.filename || stream.name || 'Manual stream',
        description: stream.description || 'Manually seeded local index stream',
        url: stream.url || lazyResolveUrlFromHash(manualInfoHash, meta),
        behaviorHints: {
          ...(stream.behaviorHints || {}),
          filename: stream.filename || stream.behaviorHints?.filename || stream.title || stream.name,
          videoSize: stream.size || stream.behaviorHints?.videoSize,
        },
      };

      const scored = scoreStreamCandidate({
        id: String(normalizedStream.url || normalizedStream.behaviorHints?.filename || normalizedStream.title || index),
        provider: 'external-addon',
        sourceType: 'cached',
        name: normalizedStream.name,
        title: normalizedStream.title,
        filename: normalizedStream.behaviorHints?.filename,
        description: normalizedStream.description,
        url: normalizedStream.url,
        size: normalizedStream.behaviorHints?.videoSize,
        raw: normalizedStream,
      }, {
        type: meta.type,
        title,
        season: meta.season,
        episode: meta.episode,
      });

      return {
        id: scored.id,
        imdbId: meta.imdbId,
        type: meta.type,
        season: meta.season,
        episode: meta.episode,
        name: scored.name,
        title: scored.title,
        filename: scored.filename,
        description: scored.description,
        url: scored.url,
        size: scored.size,
        matchDecision: scored.match?.decision,
        matchScore: scored.match?.score,
        sortScore: candidateSortScore(scored),
        bucket: bucketCandidate(scored),
        indexedAt: new Date().toISOString(),
        raw: normalizedStream,
      };
    })
    .filter((item) => item.matchDecision === 'accept');

  if (!indexed.length) {
    throw new Error('manual_index_no_accepted_streams');
  }

  const existing = await getKnownGoodStreams(meta);
  const byId = new Map<string, LocalIndexedStream>();

  for (const item of existing) byId.set(item.id, item);
  for (const item of indexed) byId.set(item.id, item);

  const merged = Array.from(byId.values())
    .sort((a, b) => (b.sortScore || 0) - (a.sortScore || 0));

  await cacheSet(localIndexKey(meta), merged, LOCAL_INDEX_TTL);

  logger.info('Saved manual streams to local index', {
    key: localIndexKey(meta),
    added: indexed.length,
    total: merged.length,
  });

  return merged;
}


export async function clearKnownGoodStreams(meta: StreamMeta): Promise<void> {
  await cacheDelete(localIndexKey(meta));

  logger.info('Cleared local index streams', {
    key: localIndexKey(meta),
    imdbId: meta.imdbId,
    season: meta.season,
    episode: meta.episode,
  });
}


export async function getKnownGoodStreams(meta: StreamMeta): Promise<LocalIndexedStream[]> {
  const { value } = await cacheGet<LocalIndexedStream[]>(
    localIndexKey(meta),
    LOCAL_INDEX_TTL,
    LOCAL_INDEX_TTL
  );

  return value || [];
}
