import axios from 'axios';
import { TorrentResult } from '../types';
import { parseQuality, parseHDR, parseDolbyVision } from '../utils/quality';
import { logger } from '../utils/logger';

interface JackettItem {
  Title: string;
  MagnetUri?: string;
  InfoHash?: string;
  Size: number;
  Seeders: number;
  Tracker: string;
  Guid: string;
}

async function getTitleFromTmdb(imdbId: string, type: 'movie' | 'series'): Promise<string | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;
  try {
    const endpoint = type === 'movie'
      ? `https://api.themoviedb.org/3/movie/${imdbId}?api_key=${apiKey}`
      : `https://api.themoviedb.org/3/tv/${imdbId}?api_key=${apiKey}`;
    const res = await axios.get<{ title?: string; name?: string; release_date?: string; first_air_date?: string }>(endpoint, { timeout: 5000 });
    const title = res.data.title || res.data.name || null;
    const year = (res.data.release_date || res.data.first_air_date || '').slice(0, 4);
    return year ? `${title} ${year}` : title;
  } catch {
    return null;
  }
}

export async function searchJackett(
  imdbId: string,
  type: 'movie' | 'series',
  season?: number,
  episode?: number
): Promise<TorrentResult[]> {
  const baseUrl = process.env.JACKETT_URL;
  const apiKey = process.env.JACKETT_API_KEY;
  const timeout = 25000;
  const maxResults = parseInt(process.env.JACKETT_MAX_RESULTS || '20');

  if (!baseUrl || !apiKey) {
    logger.warn('Jackett not configured');
    return [];
  }

  // Get title for search query
  const title = await getTitleFromTmdb(imdbId, type);
  if (!title) {
    logger.warn(`Could not resolve title for ${imdbId}`);
    return [];
  }

  let query = title;
  if (type === 'series' && season !== undefined && episode !== undefined) {
    query += ` S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`;
  }

  logger.info(`Jackett searching: "${query}" for ${imdbId}`);

  try {
    const response = await axios.get<{ Results: JackettItem[] }>(
      `${baseUrl}/api/v2.0/indexers/all/results`,
      {
        timeout,
        params: { apikey: apiKey, Query: query },
        maxRedirects: 5,
      }
    );

    const results = response.data.Results || [];
    logger.info(`Jackett returned ${results.length} results for ${imdbId} ("${query}")`);

    return results
      .filter((r) => r.InfoHash || r.MagnetUri)
      .slice(0, maxResults)
      .map((r): TorrentResult => {
        const { label } = parseQuality(r.Title);
        return {
          title: r.Title,
          infoHash: (r.InfoHash || extractInfoHash(r.MagnetUri || '') || '').toLowerCase(),
          magnetUrl: r.MagnetUri,
          size: r.Size || 0,
          seeders: r.Seeders || 0,
          quality: label,
          source: r.Tracker,
          hdr: parseHDR(r.Title),
          dolbyVision: parseDolbyVision(r.Title),
        };
      })
      .filter((r) => r.infoHash)
      .sort((a, b) => {
        const qMap: Record<string, number> = { '4K': 5, '1080p': 4, '1080i': 3, '720p': 2, '480p': 1, 'SD': 0 };
        const rankA = qMap[a.quality] ?? -1;
        const rankB = qMap[b.quality] ?? -1;
        if (rankB !== rankA) return rankB - rankA;
        return b.seeders - a.seeders;
      });
  } catch (err: any) {
    logger.error('Jackett search failed', { imdbId, query, err: err.message });
    return [];
  }
}

function extractInfoHash(magnetUrl: string): string {
  const match = magnetUrl.match(/urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return match ? match[1] : '';
}
