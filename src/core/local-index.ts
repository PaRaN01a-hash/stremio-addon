import type { Stream, StreamMeta } from '../types';
import { cacheGet, cacheSet } from '../cache/redis';
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

function expectedTitle(meta: StreamMeta, fallbackTitle?: string): string {
  return String(
    fallbackTitle ||
    (meta as any).title ||
    (meta as any).name ||
    ''
  ).trim();
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
      const scored = scoreStreamCandidate({
        id: String(stream.url || stream.behaviorHints?.filename || stream.title || stream.name || index),
        provider: stream.name?.startsWith('[TB+]') ? 'torbox' : 'external-addon',
        sourceType: stream.name?.startsWith('[TB+]') ? 'cached' : 'external',
        name: stream.name,
        title: stream.title,
        filename: stream.behaviorHints?.filename,
        description: stream.description,
        url: stream.url,
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
      const normalizedStream: Stream = {
        name: stream.name || '[Manual] Stream',
        title: stream.title || stream.filename || stream.name || 'Manual stream',
        description: stream.description || 'Manually seeded local index stream',
        url: stream.url,
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


export async function getKnownGoodStreams(meta: StreamMeta): Promise<LocalIndexedStream[]> {
  const { value } = await cacheGet<LocalIndexedStream[]>(
    localIndexKey(meta),
    LOCAL_INDEX_TTL,
    LOCAL_INDEX_TTL
  );

  return value || [];
}
