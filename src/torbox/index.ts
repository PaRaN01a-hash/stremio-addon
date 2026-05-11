import axios, { AxiosInstance } from 'axios';
import pLimit from 'p-limit';
import { TorrentResult, DebridResult } from '../types';
import { cacheGet, cacheSet, CacheKeys } from '../cache/redis';
import { logger } from '../utils/logger';

const DEBRID_CACHE_TTL = parseInt(process.env.CACHE_TTL_DEBRID || '86400');
const BASE_URL = 'https://api.torbox.app/v1/api'; function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getKey(): string {
  return process.env.TORBOX_API_KEY || '';
}

export async function checkDebridAvailability(
  infoHashes: string[]
): Promise<Map<string, boolean>> {
  if (!infoHashes.length) return new Map();
  const result = new Map<string, boolean>();

  const uncachedHashes: string[] = [];
  await Promise.all(
    infoHashes.map(async (hash) => {
      const { value } = await cacheGet<boolean>(CacheKeys.debridAvailability(hash), DEBRID_CACHE_TTL);
      if (value !== null) result.set(hash, value);
      else uncachedHashes.push(hash);
    })
  );

  if (!uncachedHashes.length) return result;

  try {
    const response = await axios.get(`${BASE_URL}/torrents/checkcached`, {
      headers: { Authorization: `Bearer ${getKey()}` },
      params: { hash: uncachedHashes.join(','), format: 'object', list_files: false },
      timeout: 10000,
    });

    const data = response.data?.data || {};
    await Promise.all(
      uncachedHashes.map(async (hash) => {
        const cached = !!data[hash];
        result.set(hash, cached);
        await cacheSet(CacheKeys.debridAvailability(hash), cached, DEBRID_CACHE_TTL);
      })
    );

    const cachedCount = uncachedHashes.filter((h) => result.get(h)).length;
    logger.info(`TorBox: ${cachedCount}/${uncachedHashes.length} hashes cached`);
  } catch (err: any) {
    logger.error('TorBox availability check failed', { err: err.message });
    uncachedHashes.forEach((h) => result.set(h, false));
  }

  return result;
}

export async function getDebridStreamUrl( torrent: TorrentResult, season?: number, episode?: number ): Promise<string | null> {
  try {
    const params: Record<string, any> = {
      token: getKey(),
      hash: torrent.infoHash,
      file_id: 0,
    };

    if (season !== undefined) params.season = season;
    if (episode !== undefined) params.episode = episode;

    const response = await axios.get(`${BASE_URL}/torrents/requestdl`, {
      params,
      timeout: 15000,
    });

    const url = response.data?.data;
    return typeof url === 'string' ? url : null;
  } catch (err: any) {
    const status = err?.response?.status;

    if (status === 429) {
      logger.warn('TorBox rate limited on requestdl, skipping torrent', {
        hash: torrent.infoHash,
      });
      await sleep(1200);
      return null;
    }

    if (status === 422) {
      logger.warn('TorBox rejected requestdl for torrent', {
        hash: torrent.infoHash,
      });
      return null;
    }

    logger.error('TorBox stream URL failed', {
      hash: torrent.infoHash,
      err: err.message,
    });
    return null;
  }
}

export async function autoCache(torrent: TorrentResult): Promise<void> {
  if (process.env.TORBOX_AUTO_CACHE !== 'true') return;
  if (!torrent.magnetUrl && !torrent.infoHash) return;
  try {
    await axios.post(`${BASE_URL}/torrents/createtorrent`, {
      magnet: torrent.magnetUrl || `magnet:?xt=urn:btih:${torrent.infoHash}`,
      seed: 1,
      allow_zip: false,
    }, {
      headers: { Authorization: `Bearer ${getKey()}` },
      timeout: 10000,
    });
    logger.info(`Auto-cache triggered for ${torrent.title}`);
  } catch (err: any) {
    logger.debug('Auto-cache failed (non-fatal)', { title: torrent.title, err: err.message });
  }
}

export async function resolveDebrid(
  torrents: TorrentResult[],
  season?: number,
  episode?: number
): Promise<DebridResult[]> {
  if (!torrents.length) return [];

  const hashes = torrents.map((t) => t.infoHash).filter(Boolean);
  const availability = await checkDebridAvailability(hashes);

  const cachedTorrents = torrents.filter((t) => availability.get(t.infoHash));
  const uncachedTorrents = torrents.filter((t) => !availability.get(t.infoHash));

  // Auto-cache top uncached in background
  const concurrency = parseInt(process.env.TORBOX_AUTO_CACHE_CONCURRENCY || '3');
  uncachedTorrents.slice(0, concurrency).forEach((t) => autoCache(t));

  // Only get stream URLs for TOP 3 cached torrents to avoid rate limiting
  const top3 = cachedTorrents.slice(0, 3);
  const limit = pLimit(2); // max 2 concurrent requestdl calls
  const results = await Promise.all(
    top3.map((torrent) =>
      limit(async (): Promise<DebridResult> => {
        const streamUrl = await getDebridStreamUrl(torrent, season, episode);
        return { cached: true, streamUrl: streamUrl || undefined, torrent };
      })
    )
  );

  const uncachedResults: DebridResult[] = uncachedTorrents.map((t) => ({
    cached: false,
    torrent: t,
  }));

  return [...results, ...uncachedResults];
}
