// src/http-fallback/index.ts
import axios from 'axios';
import { HttpStream } from '../types';
import { logger } from '../utils/logger';

// ─── VidSrc ───────────────────────────────────────────────────────────────────
async function getVidSrcStreams(
  imdbId: string,
  season?: number,
  episode?: number
): Promise<HttpStream[]> {
  if (process.env.ENABLE_VIDSRC !== 'true') return [];

  try {
    // VidSrc embed URL — works as a direct stream source via their API
    const base = 'https://vidsrc.xyz/embed';
    const url =
      season !== undefined
        ? `${base}/tv?imdb=${imdbId}&season=${season}&episode=${episode}`
        : `${base}/movie?imdb=${imdbId}`;

    // Check that the page exists (quick HEAD request)
    await axios.head(url, { timeout: 3000 });

    return [
      {
        name: 'VidSrc',
        url,
        quality: 'Unknown',
        source: 'vidsrc',
        headers: { Referer: 'https://vidsrc.xyz' },
      },
    ];
  } catch {
    return [];
  }
}

// ─── VixSrc ───────────────────────────────────────────────────────────────────
async function getVixSrcStreams(
  imdbId: string,
  season?: number,
  episode?: number
): Promise<HttpStream[]> {
  if (process.env.ENABLE_VIXSRC !== 'true') return [];

  try {
    const base = 'https://vixsrc.to/embed';
    const url =
      season !== undefined
        ? `${base}/tv/${imdbId}/${season}/${episode}`
        : `${base}/movie/${imdbId}`;

    await axios.head(url, { timeout: 3000 });

    return [
      {
        name: 'VixSrc',
        url,
        quality: 'Unknown',
        source: 'vixsrc',
        headers: { Referer: 'https://vixsrc.to' },
      },
    ];
  } catch {
    return [];
  }
}

// ─── ShowBox / FebBox ─────────────────────────────────────────────────────────
async function getShowBoxStreams(
  imdbId: string,
  season?: number,
  episode?: number
): Promise<HttpStream[]> {
  if (process.env.ENABLE_SHOWBOX !== 'true') return [];
  const cookie = process.env.FEBBOX_COOKIE;
  if (!cookie) {
    logger.warn('ShowBox enabled but FEBBOX_COOKIE not set');
    return [];
  }

  try {
    const proxyUrl = process.env.SHOWBOX_PROXY_URL || '';
    const targetUrl =
      season !== undefined
        ? `https://www.febbox.com/file/player?imdb=${imdbId}&season=${season}&ep=${episode}`
        : `https://www.febbox.com/file/player?imdb=${imdbId}`;

    const url = proxyUrl ? `${proxyUrl}${encodeURIComponent(targetUrl)}` : targetUrl;

    const res = await axios.get(url, {
      timeout: 6000,
      headers: {
        Cookie: `ui=${cookie}`,
        Referer: 'https://www.febbox.com',
      },
    });

    // Extract stream URLs from response (simplified — real impl would parse the JS/JSON payload)
    const streams: HttpStream[] = [];
    const m3u8Matches = res.data?.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/gi) || [];

    for (const streamUrl of m3u8Matches.slice(0, 3)) {
      streams.push({
        name: 'ShowBox',
        url: streamUrl,
        quality: '1080p',
        source: 'showbox',
        headers: { Cookie: `ui=${cookie}`, Referer: 'https://www.febbox.com' },
      });
    }

    return streams;
  } catch (err: any) {
    logger.debug('ShowBox failed', { err: err.message });
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function getHttpFallbackStreams(
  imdbId: string,
  season?: number,
  episode?: number
): Promise<HttpStream[]> {
  const results = await Promise.allSettled([
    getVidSrcStreams(imdbId, season, episode),
    getVixSrcStreams(imdbId, season, episode),
    getShowBoxStreams(imdbId, season, episode),
  ]);

  return results
    .filter((r): r is PromiseFulfilledResult<HttpStream[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);
}
