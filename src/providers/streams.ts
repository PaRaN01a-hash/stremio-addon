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
import { getExternalStremioStreams } from './external-stremio';
import { parseReleaseTitle } from '../utils/release-parser';
import { scoreReleaseMatch } from '../utils/match-score';
import { scoreStreamCandidate } from '../core/candidate-match';
import { sortCandidates } from '../core/candidate-sort';
import { getKnownGoodStreams, saveKnownGoodStreams } from '../core/local-index';
import {
  filterStreams,
  sortStreams,
  dedupeStreams,
  capStreamsPerQuality,
  capStreamsPerProvider,
  NormalizedStream
} from '../streams';

const STREAM_SOFT_TTL = parseInt(process.env.CACHE_TTL_STREAMS || '1800');
const STREAM_HARD_TTL = STREAM_SOFT_TTL * 4; // Keep in Redis 4x longer than soft TTL

function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || 'http://localhost:6000').replace(/\/$/, '');
}

function coreSortStreamsEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.CORE_SORT_STREAMS || '').toLowerCase()
  );
}

function externalAddonsOnColdLoadEnabled(): boolean {
  const value = String(process.env.EXTERNAL_ADDONS_ON_COLD_LOAD || 'true').toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

function localIndexFirstEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.LOCAL_INDEX_FIRST || '').toLowerCase()
  );
}

function expectedTitleForCoreMatch(meta: StreamMeta): string {
  return String(
    (meta as any).title ||
    (meta as any).name ||
    expectedSeriesTitle(meta) ||
    ''
  ).trim();
}

function coreSortStreamResults(streams: Stream[], meta: StreamMeta): Stream[] {
  const expectedTitle = expectedTitleForCoreMatch(meta);

  const scoredCandidates = streams.map((stream: any, index: number) =>
    scoreStreamCandidate({
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
      title: expectedTitle,
      season: meta.season,
      episode: meta.episode,
    })
  );

  return sortCandidates(scoredCandidates).map((candidate) => candidate.raw as Stream);
}

function lazyTorBoxUrl(hash: string, season?: number, episode?: number): string {
  const url = new URL('/resolve', publicBaseUrl());
  url.searchParams.set('hash', hash);
  if (season !== undefined) url.searchParams.set('season', String(season));
  if (episode !== undefined) url.searchParams.set('episode', String(episode));
  return url.toString();
}


function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return 'Unknown';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 / 1024;
  return `${Math.round(mb)} MB`;
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

  const hashSource = [
    anyStream.infoHash || '',
    anyStream.behaviorHints?.bingeGroup || '',
    anyStream.behaviorHints?.filename || '',
    stream.url || '',
    stream.name || '',
    stream.title || '',
  ].join(' ');

  const hashMatch = hashSource.match(/[a-f0-9]{40}/i);
  if (hashMatch) return `hash:${hashMatch[0].toLowerCase()}`;

  const url = String(stream.url || '').trim().toLowerCase();
  if (url) return `url:${url}`;

  const filename = String(anyStream.behaviorHints?.filename || '')
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\b(torrentio|comet|hdhub|torbox|tb)\b/g, '')
    .replace(/[⚡⏳]/g, '')
    .replace(/[^a-z0-9]+/g, '');

  if (filename) return `file:${filename}`;

  const text = streamText(stream)
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\b(torrentio|comet|hdhub|torbox|tb)\b/g, '')
    .replace(/[⚡⏳]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const size = streamSize(stream);
  if (size > 0) return `text:${text}:size:${Math.round(size / 50000000)}`;

  return `text:${text}`;
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


function providerQualityKey(stream: Stream): string {
  const text = streamText(stream);
  const host = (() => {
    try { return new URL(String(stream.url || '')).hostname.replace(/^www\./, ''); }
    catch { return ''; }
  })();

  let provider = 'other';
  if (text.includes('comet') || host.includes('comet')) provider = 'comet';
  else if (text.includes('torrentio') || host.includes('torrentio')) provider = 'torrentio';
  else if (text.includes('hdhub') || host.includes('hdhub')) provider = 'hdhub';

  let quality = 'unknown';
  if (text.includes('2160') || text.includes('4k')) quality = '2160p';
  else if (text.includes('1080')) quality = '1080p';
  else if (text.includes('720')) quality = '720p';

  return `${provider}:${quality}`;
}

function capProviderQuality(streams: Stream[], limit = 12): Stream[] {
  const counts = new Map<string, number>();
  const out: Stream[] = [];

  for (const stream of streams) {
    const key = providerQualityKey(stream);
    const count = counts.get(key) || 0;
    if (count >= limit) continue;
    counts.set(key, count + 1);
    out.push(stream);
  }

  return out;
}


function isWeakStream(stream: Stream): boolean {
  const text = streamText(stream);
  const name = String(stream.name || '').toLowerCase().trim();
  const title = String(stream.title || '').toLowerCase().trim();
  const filename = String((stream as any).behaviorHints?.filename || '').toLowerCase();
  const bingeGroup = String(stream.behaviorHints?.bingeGroup || '').toLowerCase();

  const isTorrentio = text.includes('torrentio');
  const visible = `${name} ${title}`.toLowerCase().trim();

  const hasQuality =
    visible.includes('2160') || visible.includes('4k') ||
    visible.includes('1080') || visible.includes('720') || visible.includes('480') ||
    filename.includes('2160') || filename.includes('4k') ||
    filename.includes('1080') || filename.includes('720') || filename.includes('480');

  const hasUsefulSource =
    visible.includes('web') || visible.includes('bluray') || visible.includes('blu-ray') ||
    visible.includes('x264') || visible.includes('x265') || visible.includes('hevc') ||
    visible.includes('hdr') || filename.includes('web') || filename.includes('bluray') ||
    filename.includes('blu-ray') || filename.includes('x264') || filename.includes('x265') ||
    filename.includes('hevc') || filename.includes('hdr') ||
    bingeGroup.match(/web|bluray|blu-ray|hdr|hevc|x265|x264/);

  const torrentioVisibleHasQuality =
    name.includes('2160') || name.includes('4k') ||
    name.includes('1080') || name.includes('720') || name.includes('480') ||
    title.includes('2160') || title.includes('4k') ||
    title.includes('1080') || title.includes('720') || title.includes('480');

  if (isTorrentio && !torrentioVisibleHasQuality) return true;
  if (isTorrentio && !hasQuality) return true;
  if (isTorrentio && !hasUsefulSource && !hasQuality) return true;
  if (text.includes('unknown') && !hasQuality && !hasUsefulSource) return true;
  if (!stream.url && !(stream as any).infoHash && !stream.behaviorHints?.bingeGroup) return true;

  return false;
}


function finalVisibleStreamFilter(stream: Stream): boolean {
  const name = String(stream.name || '').toLowerCase().trim();
  const title = String(stream.title || '').toLowerCase().trim();
  const visible = `${name} ${title}`;

  const isTorrentio = visible.includes('torrentio');
  const hasVisibleQuality =
    visible.includes('2160') || visible.includes('4k') ||
    visible.includes('1080') || visible.includes('720') || visible.includes('480');

  if (isTorrentio && !hasVisibleQuality) return false;

  return true;
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

  const sorted = [...byKey.values()]
      .sort((a, b) => scoreStream(b) - scoreStream(a));

    return capProviderQuality(sorted, parseInt(process.env.MAX_PER_PROVIDER_QUALITY || '2'))
      .filter(finalVisibleStreamFilter)
      .slice(0, parseInt(process.env.MAX_FINAL_STREAMS || '40'));
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




function expectedSeriesTitle(meta: StreamMeta): string {
  const fallbacks: Record<string, string> = {
    tt0108778: 'Friends',
    tt9813792: 'From',
    tt1877005: 'Moonshiners',
  };

  return String(
    (meta as any).title ||
    (meta as any).name ||
    (meta as any).showName ||
    fallbacks[meta.imdbId] ||
    ''
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMatchText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function streamMatchesRequestedEpisode(stream: Stream, meta: StreamMeta): boolean {
  if (meta.type !== 'series') return true;
  if (meta.season === undefined || meta.episode === undefined) return true;

  const text = String(
    (stream as any).filename ||
    (stream as any).title ||
    (stream as any).description ||
    stream.name ||
    ''
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

  const s = String(meta.season).padStart(2, '0');
  const e = String(meta.episode).padStart(2, '0');

  const requested = [
    `s${s}e${e}`,
    `${Number(meta.season)}x${Number(meta.episode)}`,
  ];

  const hasAnyEpisode =
    /s\d{1,2}e\d{1,2}/i.test(text) ||
    /\d{1,2}x\d{1,2}/i.test(text);

  if (!hasAnyEpisode) return true;

  return requested.some((pattern) => text.includes(pattern));
}


interface TorrentRejectStats {
  total: number;
  penalties: Record<string, number>;
  examples: Array<{
    releaseTitle: string;
    score: number;
    penalties: string[];
  }>;
}

function createTorrentRejectStats(): TorrentRejectStats {
  return {
    total: 0,
    penalties: {},
    examples: [],
  };
}

function recordTorrentReject(stats: TorrentRejectStats | undefined, releaseTitle: string, smartMatch: any): void {
  if (!stats) return;

  stats.total++;

  for (const penalty of smartMatch.penalties || []) {
    stats.penalties[penalty] = (stats.penalties[penalty] || 0) + 1;
  }

  if (stats.examples.length < 5) {
    stats.examples.push({
      releaseTitle,
      score: smartMatch.score,
      penalties: smartMatch.penalties || [],
    });
  }
}

function torrentMatchesExpectedSeries(
  torrent: { title?: string },
  meta: StreamMeta,
  rejectStats?: TorrentRejectStats
): boolean {
  if (meta.type !== 'series') return true;

  const expected = expectedSeriesTitle(meta);
  if (!expected) return true;

  const releaseTitle = torrent.title || '';
  const title = normalizeMatchText(releaseTitle);
  if (!title) return false;

  const parsed = parseReleaseTitle(releaseTitle);
  const smartMatch = scoreReleaseMatch(parsed, {
    type: 'series',
    title: expected,
    season: meta.season,
    episode: meta.episode,
  });

  if (smartMatch.decision === 'reject') {
    recordTorrentReject(rejectStats, releaseTitle, smartMatch);
    return false;
  }

  const compactTitle = title.replace(/\s+/g, '');

  // Legacy fallback guard:
  // If the release explicitly names an episode, it must match the requested one.
  // Season packs are still allowed because TorBox can resolve files inside packs.
  if (meta.season !== undefined && meta.episode !== undefined) {
    const s = String(meta.season).padStart(2, '0');
    const e = String(meta.episode).padStart(2, '0');

    const requestedEpisodePatterns = [
      `s${s}e${e}`,
      `${Number(meta.season)}x${Number(meta.episode)}`,
    ];

    const hasAnyEpisodeMarker =
      /s\d{1,2}e\d{1,2}/i.test(compactTitle) ||
      /\b\d{1,2}x\d{1,2}\b/i.test(compactTitle);

    const hasRequestedEpisode = requestedEpisodePatterns.some((pattern) =>
      compactTitle.includes(pattern)
    );

    if (hasAnyEpisodeMarker && !hasRequestedEpisode) {
      return false;
    }
  }

  const expectedWords = expected.split(' ').filter(Boolean);

  if (expectedWords.length > 1) {
    return title.includes(expected);
  }

  // Single-word series titles like "Friends" must start with the show title.
  // Allows: "Friends S01E01", "Friends Season 1", "Friends S01-S09".
  // Blocks: "Smiling Friends", "A Spy Among Friends", "Little House ... Friends".
  const titleMatches = (
    title === expected ||
    title.startsWith(expected + ' ') ||
    title.startsWith('the ' + expected + ' ')
  );

  if (!titleMatches) return false;

  return true;
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

    const releaseTitle = (torrent.title || 'Unknown release').replace(/\s+/g, ' ').trim();
    const titleUpper = releaseTitle.toUpperCase();

    const tags = [
      torrent.dolbyVision || titleUpper.includes('DOLBY VISION') || titleUpper.includes('DOVI') ? 'DV' : '',
      torrent.hdr || titleUpper.includes('HDR') ? 'HDR' : '',
      titleUpper.includes('REMUX') ? 'REMUX' : '',
      titleUpper.includes('WEB-DL') ? 'WEB-DL' : '',
      titleUpper.includes('BLURAY') || titleUpper.includes('BLU-RAY') ? 'BluRay' : '',
      titleUpper.includes('X265') || titleUpper.includes('H265') || titleUpper.includes('HEVC') ? 'x265' : '',
      titleUpper.includes('X264') || titleUpper.includes('H264') || titleUpper.includes('AVC') ? 'x264' : '',
      titleUpper.includes('ATMOS') ? 'Atmos' : '',
      titleUpper.includes('TRUEHD') ? 'TrueHD' : '',
      titleUpper.includes('EAC3') || titleUpper.includes('DDP') ? 'EAC3' : '',
    ].filter(Boolean);

    const badge = '[TB+]';

    const isSeasonPack =
      /\bS\d{1,2}\s*-\s*S?\d{1,2}\b/i.test(releaseTitle) ||
      /\bSeason\s*\d{1,2}\b/i.test(releaseTitle) ||
      (/\bS\d{1,2}\b/i.test(releaseTitle) && !/\bS\d{1,2}E\d{1,2}\b/i.test(releaseTitle));

    const featureText = [
      isSeasonPack ? 'Season Pack' : '',
      ...tags,
    ].filter(Boolean).slice(0, 4).join(' • ');

    const release =
      releaseTitle.match(/-([A-Za-z0-9]+)(?:\s*(?:mkv|mp4|avi))?$/i)?.[1] ||
      releaseTitle.match(/\[([A-Za-z0-9]+)\]/)?.[1] ||
      releaseTitle.match(/\b([A-Za-z0-9]{2,20})\s+(?:mkv|mp4|avi)$/i)?.[1] ||
      torrent.source ||
      'Scene';

    const weakRelease = [
      'com', 'net', 'org', 'mkv', 'mp4', 'avi', 'www',
      'p', 'extended', 'unknown', 'wiki'
    ].includes(String(release).toLowerCase());

    const cleanRelease = weakRelease ? (torrent.source || 'Scene') : release;

      const inferredQuality =
        titleUpper.includes('2160') || titleUpper.includes('4K') ? '4K' :
        titleUpper.includes('1080') ? '1080p' :
        titleUpper.includes('720') ? '720p' :
        titleUpper.includes('480') ? '480p' :
        torrent.quality || 'Unknown';

      const displayQuality =
        isSeasonPack && String(inferredQuality).toLowerCase() === 'unknown'
          ? 'Season Pack'
          : inferredQuality;

      const streamName = [
        `${badge} ${displayQuality}`,
        cleanRelease,
        ...tags,
      ]
        .filter(Boolean)
        .filter((part, index, arr) => arr.indexOf(part) === index)
        .slice(0, 6)
        .join(' • ');

    const sourceLine = `${torrent.source || 'Unknown'}${torrent.source === 'Zilean-DMM' ? ' Lazy Movie | zilean_dmm' : ''}`;

    streams.push({
      name: streamName,
      title: releaseTitle,
      description: `${sourceLine}\nSIZE ${formatBytes(torrent.size)}${torrent.seeders ? ` · 👥 ${torrent.seeders}` : ''}`,
      url: lazyTorBoxUrl(torrent.infoHash, season, episode),
      behaviorHints: {
        bingeGroup: `tbplus-${torrent.quality}-${cleanRelease}-${torrent.infoHash}`,
        filename: releaseTitle,
        videoSize: torrent.size || undefined,
      },
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

  
const normalized: NormalizedStream[] = streams.map((s: any) => ({
  id: s.url,

  provider: 'maximus',
  source: s.name || 'unknown',

  title: s.title || '',
  releaseGroup: s.behaviorHints?.filename || '',

  infoHash: '',

  url: s.url,

  quality:
    s.name?.includes('4K') ? '4K' :
    s.name?.includes('1080') ? '1080p' :
    s.name?.includes('720') ? '720p' :
    'Unknown',

  codec:
    s.title?.includes('x265') ? 'x265' :
    s.title?.includes('x264') ? 'x264' :
    undefined,

  hdr:
    s.name?.includes('HDR') ||
    s.title?.includes('HDR'),

  dolbyVision:
    s.name?.includes('DV') ||
    s.title?.includes('DV'),

  size:
    s.behaviorHints?.videoSize || 0,

  seeders: 0,

  cached: true,

  bingeGroup:
    s.behaviorHints?.bingeGroup,

  raw: s
}));

const filtered = filterStreams(normalized);
const deduped = dedupeStreams(filtered);
const providerCapped = capStreamsPerProvider(deduped);
const capped = capStreamsPerQuality(providerCapped);
  const sorted = sortStreams(capped);

return sorted.map(s => s.raw);

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
  if ((globalThis as any).streamStats) {
    (globalThis as any).streamStats.zileanMs = msSince(providerStart);
  }
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
  const rejectStats = createTorrentRejectStats();
  const titleGuardedTorrents = torrents.filter((torrent) =>
    torrentMatchesExpectedSeries(torrent, meta, rejectStats)
  );

  if (titleGuardedTorrents.length !== torrents.length) {
    logger.info('Series title guard filtered torrents', {
      imdbId,
      before: torrents.length,
      after: titleGuardedTorrents.length,
      rejected: rejectStats.total,
      penalties: rejectStats.penalties,
      examples: rejectStats.examples,
    });
  }

    const debridResults = await resolveDebrid(titleGuardedTorrents, season, episode);
  if ((globalThis as any).streamStats) {
    (globalThis as any).streamStats.torboxMs = msSince(torboxStart);
  }
  logger.info('TorBox resolveDebrid complete', {
    imdbId,
    ms: msSince(torboxStart),
    torrents: titleGuardedTorrents.length,
    cached: debridResults.filter((r) => r.cached).length,
  });

  const internalStreams = buildStreams(debridResults, httpStreams, season, episode)
      .filter((stream) => streamMatchesRequestedEpisode(stream, meta));
  const includeExternalOnColdLoad = externalAddonsOnColdLoadEnabled();

  const [externalStremioStreams, externalAddonStreams] = includeExternalOnColdLoad
    ? await Promise.all([
        getExternalStremioStreams(meta.type, meta.id, season, episode),
        getExternalAddonStreams(meta),
      ])
    : [[], []];

  if (!includeExternalOnColdLoad) {
    logger.info('External addons skipped on cold load', { imdbId });
  }

  const streams = cleanStreams([
    ...internalStreams,
    ...externalStremioStreams,
    ...externalAddonStreams,
  ]);

  const finalStreams = coreSortStreamsEnabled()
    ? coreSortStreamResults(streams, meta)
    : streams;

  if (coreSortStreamsEnabled()) {
    logger.info('Core stream sorting enabled', {
      imdbId,
      before: streams.length,
      after: finalStreams.length,
    });
  }

  logger.info(`Fetched ${finalStreams.length} streams for ${imdbId}`, {
    debrid: debridResults.filter((r) => r.cached).length,
    http: httpStreams.length,
    totalMs: msSince(started),
    coreSort: coreSortStreamsEnabled(),
  });

  await saveKnownGoodStreams(meta, finalStreams, expectedTitleForCoreMatch(meta));

  return finalStreams;
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
  logger.info('External mixer meta debug', { meta });
  getExternalAddonStreams(meta)
    .then(async (externalStreams) => {
      if (!externalStreams.length) return;
      // External addons can be noisy for series search terms like "Friends".
      // Keep Maximus/TB+ streams as the anchor, then add only a small filtered external sample.
      const expectedTitle = String((meta as any).title || (meta as any).name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

      const looksLikeExpectedSeries = (stream: Stream) => {
        if (!((meta as any).season || (meta as any).episode) || !expectedTitle) return true;

        const haystack = [
          stream.name,
          stream.title,
          stream.description,
          (stream as any).filename,
        ].filter(Boolean).join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

        // For short/simple show names, require the exact normalized title as a word-ish phrase.
        return haystack.includes(expectedTitle);
      };

      const safeExternalStreams = externalStreams
        .filter(looksLikeExpectedSeries)
        .slice(0, parseInt(process.env.MAX_EXTERNAL_STREAMS || '4'));

      const merged = cleanStreams([
        ...baseStreams,
        ...safeExternalStreams,
      ]);

    const finalMerged = coreSortStreamsEnabled()
      ? coreSortStreamResults(merged, meta)
      : merged;

    await cacheSet(cacheKey, finalMerged, STREAM_HARD_TTL);
      if ((globalThis as any).streamStats) {
        (globalThis as any).streamStats.externalRefreshes =
          ((globalThis as any).streamStats.externalRefreshes || 0) + 1;
        (globalThis as any).streamStats.externalLastCount = externalStreams.length;
      }
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
  const stats = (globalThis as any).streamStats;
  if (stats) {
    stats.requests++;
    stats.lastRequest = new Date().toISOString();
  }

  const { imdbId, season, episode } = meta;
  const cacheKey = CacheKeys.streams(imdbId, season, episode);

  if (localIndexFirstEnabled()) {
    const indexed = await getKnownGoodStreams(meta);

    if (indexed.length > 0) {
      if (stats) stats.cacheHits++;

      const indexedStreams = indexed.map((item) => item.raw);

      logger.info('Local index first hit', {
        imdbId,
        season,
        episode,
        count: indexedStreams.length,
      });

      backgroundRefresh(meta, cacheKey);

      return coreSortStreamsEnabled()
        ? coreSortStreamResults(indexedStreams, meta)
        : indexedStreams;
    }

    logger.info('Local index first miss', {
      imdbId,
      season,
      episode,
    });
  }

  const { value: cached, stale } = await cacheGet<Stream[]>(cacheKey, STREAM_SOFT_TTL, STREAM_HARD_TTL);

  if (cached !== null) {
    if (stats) stats.cacheHits++;
    logger.info('Stream cache hit', { cacheKey, stale, count: cached.length });
    if (stale) {
      logger.debug('Serving stale cache, refreshing in background', { cacheKey });
      backgroundRefresh(meta, cacheKey);
    }
      const cachedStreams = cleanStreams(cached);
      return coreSortStreamsEnabled()
        ? coreSortStreamResults(cachedStreams, meta)
        : cachedStreams;
  }

  // Cache miss — fetch full lazy TorBox stream list now.
  // This is slower on the first request, but avoids returning an empty list.
  if (stats) stats.cacheMisses++;
  logger.info('Cache miss, fetching fresh lazy streams', { imdbId });
  const freshStreams = await fetchFreshStreams(meta);
  if (freshStreams.length > 0) {
    await cacheSet(cacheKey, freshStreams, STREAM_HARD_TTL);

    if (!externalAddonsOnColdLoadEnabled()) {
      backgroundExternalRefresh(meta, cacheKey, freshStreams);
    }
  }
  return freshStreams;
}
