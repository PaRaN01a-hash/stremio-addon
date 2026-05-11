// src/workers/precache.ts
import cron from 'node-cron';
import axios from 'axios';
import { getStreams } from '../providers/streams';
import { StreamMeta } from '../types';
import { logger } from '../utils/logger';
import pLimit from 'p-limit';

interface TmdbItem {
  id: number;
  imdb_id?: string;
  title?: string;
  name?: string;
  media_type?: string;
}

/**
 * Fetch trending/popular titles from TMDB to pre-cache.
 */
async function fetchTrendingTitles(limit: number): Promise<StreamMeta[]> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    logger.warn('TMDB_API_KEY not set — skipping pre-cache');
    return [];
  }

  try {
    const [moviesRes, tvRes] = await Promise.all([
      axios.get<{ results: TmdbItem[] }>('https://api.themoviedb.org/3/trending/movie/week', {
        params: { api_key: apiKey },
        timeout: 5000,
      }),
      axios.get<{ results: TmdbItem[] }>('https://api.themoviedb.org/3/trending/tv/week', {
        params: { api_key: apiKey },
        timeout: 5000,
      }),
    ]);

    const movies = moviesRes.data.results.slice(0, Math.floor(limit / 2));
    const tv = tvRes.data.results.slice(0, Math.ceil(limit / 2));

    const metas: StreamMeta[] = [];

    // Get IMDB IDs for movies
    for (const movie of movies) {
      const detail = await axios
        .get<{ imdb_id: string }>(`https://api.themoviedb.org/3/movie/${movie.id}/external_ids`, {
          params: { api_key: apiKey },
          timeout: 3000,
        })
        .catch(() => null);

      const imdbId = detail?.data?.imdb_id;
      if (imdbId) {
        metas.push({ id: imdbId, type: 'movie', imdbId });
      }
    }

    // Get IMDB IDs for TV (season 1, episode 1 as representative)
    for (const show of tv) {
      const detail = await axios
        .get<{ imdb_id: string }>(`https://api.themoviedb.org/3/tv/${show.id}/external_ids`, {
          params: { api_key: apiKey },
          timeout: 3000,
        })
        .catch(() => null);

      const imdbId = detail?.data?.imdb_id;
      if (imdbId) {
        metas.push({ id: `${imdbId}:1:1`, type: 'series', imdbId, season: 1, episode: 1 });
      }
    }

    logger.info(`Pre-cache: found ${metas.length} titles to warm`);
    return metas;
  } catch (err: any) {
    logger.error('Failed to fetch trending titles', { err: err.message });
    return [];
  }
}

async function runPrecache(): Promise<void> {
  logger.info('Pre-cache worker starting');
  const limit = parseInt(process.env.PRECACHE_LIMIT || '50');
  const metas = await fetchTrendingTitles(limit);

  const concurrencyLimit = pLimit(3);
  let success = 0, failed = 0;

  await Promise.all(
    metas.map((meta) =>
      concurrencyLimit(async () => {
        try {
          await getStreams(meta);
          success++;
        } catch {
          failed++;
        }
      })
    )
  );

  logger.info(`Pre-cache complete: ${success} warmed, ${failed} failed`);
}

export function startPrecacheWorker(): void {
  if (process.env.PRECACHE_ENABLED !== 'true') {
    logger.info('Pre-cache worker disabled');
    return;
  }

  const schedule = process.env.PRECACHE_CRON || '0 */6 * * *';
  logger.info(`Pre-cache worker scheduled: ${schedule}`);

  cron.schedule(schedule, () => {
    runPrecache().catch((err) => logger.error('Pre-cache run failed', { err: err.message }));
  });

  // Run immediately on startup after a short delay
  setTimeout(() => {
    runPrecache().catch((err) => logger.error('Initial pre-cache failed', { err: err.message }));
  }, 10_000);
}
