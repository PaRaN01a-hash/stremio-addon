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

function expectedTitle(meta: StreamMeta): string {
  return String(
    (meta as any).title ||
    (meta as any).name ||
    ''
  ).trim();
}

export async function saveKnownGoodStreams(meta: StreamMeta, streams: Stream[]): Promise<void> {
  if (!streams.length) return;

  const title = expectedTitle(meta);
  if (!title) return;

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

export async function getKnownGoodStreams(meta: StreamMeta): Promise<LocalIndexedStream[]> {
  const { value } = await cacheGet<LocalIndexedStream[]>(
    localIndexKey(meta),
    LOCAL_INDEX_TTL,
    LOCAL_INDEX_TTL
  );

  return value || [];
}
