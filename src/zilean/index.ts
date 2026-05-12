import axios from 'axios';
import { TorrentResult, StreamMeta } from '../types';
import { getTitleFromTmdb } from '../jackett';
import { logger } from '../utils/logger';

const BASE_URL = process.env.ZILEAN_URL || 'http://zilean:8181';

function qualityFromResolution(resolution?: string): string {
  if (!resolution) return 'Unknown';
  if (resolution.includes('2160')) return '4K';
  if (resolution.includes('1080')) return '1080p';
  if (resolution.includes('720')) return '720p';
  return resolution;
}

export async function searchZilean(meta: StreamMeta): Promise<TorrentResult[]> {
  const apiKey = process.env.ZILEAN_API_KEY;
  if (!apiKey) return [];

  const resolvedTitle = await getTitleFromTmdb(meta.imdbId, meta.type);
  let query = resolvedTitle || meta.imdbId;
  let year: string | undefined;

  const yearMatch = query.match(/\b(19\d{2}|20\d{2})$/);
  if (yearMatch) {
    year = yearMatch[1];
    query = query.replace(/\s+\b(19\d{2}|20\d{2})$/, '').trim();
  }

  const params: Record<string, any> = {
    query,
  };

  if (year) params.year = year;
  if (meta.season !== undefined) params.season = meta.season;
  if (meta.episode !== undefined) params.episode = meta.episode;

  try {
    const res = await axios.get(`${BASE_URL}/dmm/filtered`, {
      params,
      headers: { 'X-Api-Key': apiKey },
      timeout: 8000,
    });

    const rows = Array.isArray(res.data) ? res.data : [];
    const max = parseInt(process.env.ZILEAN_MAX_RESULTS || '60');

    const results: TorrentResult[] = rows
      .filter((r: any) => r?.info_hash)
      .slice(0, max)
      .map((r: any): TorrentResult => {
        const hdrList = Array.isArray(r.hdr) ? r.hdr.join(' ') : String(r.hdr || '');
        const raw = String(r.raw_title || r.parsed_title || 'Zilean DMM');

        return {
          title: raw,
          infoHash: String(r.info_hash).toLowerCase(),
          magnetUrl: `magnet:?xt=urn:btih:${String(r.info_hash).toLowerCase()}`,
          size: Number(r.size || 0),
          seeders: 0,
          quality: qualityFromResolution(String(r.resolution || '')),
          source: 'Zilean-DMM',
          hdr: hdrList.toLowerCase().includes('hdr'),
          dolbyVision:
            hdrList.toLowerCase().includes('dv') ||
            hdrList.toLowerCase().includes('dolby vision') ||
            raw.toLowerCase().includes('dovi'),
        };
      });

    logger.info(`Zilean DMM returned ${results.length} results for ${meta.imdbId}`);
    return results;
  } catch (err: any) {
    logger.warn('Zilean DMM search failed', { err: err.message });
    return [];
  }
}
