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

type TorBoxFile = {
  id?: number | string;
  file_id?: number | string;
  name?: string;
  filename?: string;
  path?: string;
  size?: number | string;
};

function isVideoFile(name: string): boolean {
  return /\.(mkv|mp4|avi|mov|m4v|webm)$/i.test(name);
}

function fileSize(file: TorBoxFile): number {
  return Number(file.size || 0);
}

function fileName(file: TorBoxFile): string {
  return String(file.name || file.filename || file.path || '');
}

function fileId(file: TorBoxFile): number | null {
  const id = file.id ?? file.file_id;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

function episodeRegexes(season?: number, episode?: number): RegExp[] {
  if (season === undefined || episode === undefined) return [];

  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');

  return [
    new RegExp(`s${s}\\s*e${e}`, 'i'),
    new RegExp(`s${season}\\s*e${episode}`, 'i'),
    new RegExp(`${season}\\s*x\\s*${episode}`, 'i'),
    new RegExp(`season\\s*${season}.*episode\\s*${episode}`, 'i'),
    new RegExp(`\\b${s}${e}\\b`, 'i'),
  ];
}

async function getTorBoxFiles(torrentId: any): Promise<TorBoxFile[]> {
  const candidates = [
    `${BASE_URL}/torrents/mylist`,
    `${BASE_URL}/torrents/info`,
    `${BASE_URL}/torrents/list`,
  ];

  for (const url of candidates) {
    try {
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${getKey()}` },
        params: { id: torrentId, torrent_id: torrentId, bypass_cache: true },
        timeout: 10000,
      });

      const data = res.data?.data;

      const files =
        data?.files ||
        data?.torrent?.files ||
        data?.[0]?.files ||
        (Array.isArray(data) ? data.find((x: any) => String(x.id) === String(torrentId) || String(x.torrent_id) === String(torrentId))?.files : null);

      if (Array.isArray(files)) {
        return files;
      }
    } catch {
      // Try next endpoint quietly
    }
  }

  return [];
}

async function pickTorBoxFileId(
  torrentId: any,
  season?: number,
  episode?: number
): Promise<number> {
  const files = await getTorBoxFiles(torrentId);

  if (!files.length) {
    logger.warn('TorBox file list unavailable, falling back to file_id 0', { torrentId });
    return 0;
  }

  const videos = files
    .filter((file) => isVideoFile(fileName(file)))
    .sort((a, b) => fileSize(b) - fileSize(a));

  if (!videos.length) {
    logger.warn('TorBox file list had no video files, falling back to file_id 0', { torrentId });
    return 0;
  }

  const patterns = episodeRegexes(season, episode);

  if (patterns.length) {
    const matched = videos.find((file) => {
      const name = fileName(file);
      return patterns.some((pattern) => pattern.test(name));
    });

    if (matched) {
      const matchedId = fileId(matched);

      if (matchedId !== null) {
        logger.info('TorBox picked matching episode file', {
          torrentId,
          fileId: matchedId,
          file: fileName(matched),
        });
        return matchedId;
      }
    }
  }

  const largest = videos[0];
  const largestId = fileId(largest);

  if (largestId !== null) {
    logger.info('TorBox picked largest video file', {
      torrentId,
      fileId: largestId,
      file: fileName(largest),
    });
    return largestId;
  }

  return 0;
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

export async function getDebridStreamUrl(
  torrent: TorrentResult,
  season?: number,
  episode?: number
): Promise<string | null> {
  try {
    // First add/create the torrent so TorBox gives us a torrent_id.
    const form = new URLSearchParams();
    form.append('magnet', torrent.magnetUrl || `magnet:?xt=urn:btih:${torrent.infoHash}`);
    form.append('seed', '1');
    form.append('allow_zip', 'false');
    form.append('add_only_if_cached', 'true');

    const create = await axios.post(
      `${BASE_URL}/torrents/createtorrent`,
      form,
      {
        headers: {
          Authorization: `Bearer ${getKey()}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      }
    );

    const torrentId =
      create.data?.data?.torrent_id ||
      create.data?.data?.id ||
      create.data?.data;

    if (!torrentId) {
      logger.warn('TorBox create did not return torrent id', {
        hash: torrent.infoHash,
        data: create.data,
      });
      return null;
    }

    const selectedFileId = await pickTorBoxFileId(torrentId, season, episode);

    const params: Record<string, any> = {
      token: getKey(),
      torrent_id: torrentId,
      file_id: selectedFileId,
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
      logger.warn('TorBox rate limited on create/requestdl, skipping torrent', {
        hash: torrent.infoHash,
      });
      await sleep(1200);
      return null;
    }

    if (status === 422) {
      logger.warn('TorBox rejected create/requestdl for torrent', {
        hash: torrent.infoHash,
        response: err?.response?.data,
      });
      return null;
    }

    logger.error('TorBox stream URL failed', {
      hash: torrent.infoHash,
      err: err.message,
      response: err?.response?.data,
    });
    return null;
  }
}


export async function getDebridStreamUrlByHash(
  hash: string,
  season?: number,
  episode?: number
): Promise<string | null> {
  return getDebridStreamUrl(
    {
      title: `Lazy resolve ${hash}`,
      infoHash: hash,
      magnetUrl: `magnet:?xt=urn:btih:${hash}`,
      size: 0,
      seeders: 0,
      quality: 'Unknown',
      source: 'TorBox',
    } as TorrentResult,
    season,
    episode
  );
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

  const maxSizeGb = parseFloat(process.env.TORBOX_MAX_SIZE_GB || '25');
  const maxStreams = parseInt(process.env.TORBOX_MAX_STREAMS || '8');
  const maxSizeBytes = maxSizeGb * 1024 * 1024 * 1024;

  const filteredCachedTorrents = cachedTorrents.filter((torrent) => {
    const title = (torrent.title || '').toLowerCase();

    // Avoid formats that often fail on TVs/Nuvio/Stremio players
    if (
      title.includes('dolby vision') ||
      title.includes('dovi') ||
      title.includes(' dv ') ||
      title.includes('.dv.') ||
      title.includes('remux')
    ) {
      return false;
    }

    if (!torrent.size || torrent.size <= 0) return true;
    return torrent.size <= maxSizeBytes;
  });

  logger.info(
    `TorBox: ${filteredCachedTorrents.length}/${cachedTorrents.length} cached torrents under ${maxSizeGb}GB`
  );

  // Get more streams, but avoid huge remux files and API hammering
  const top3 = filteredCachedTorrents.slice(0, maxStreams);
  const results = await Promise.all(
    top3.map((torrent): DebridResult => ({
      cached: true,
      streamUrl: `lazy:${torrent.infoHash}`,
      torrent,
    }))
  );

  const uncachedResults: DebridResult[] = uncachedTorrents.map((t) => ({
    cached: false,
    torrent: t,
  }));

  return [...results, ...uncachedResults];
}
