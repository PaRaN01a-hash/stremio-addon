export type ReleaseType =
  | 'episode'
  | 'season-pack'
  | 'movie'
  | 'unknown';

export type ReleaseQuality =
  | '2160p'
  | '1080p'
  | '720p'
  | '480p'
  | 'unknown';

export interface ParsedReleaseTitle {
  raw: string;
  cleaned: string;
  normalizedTitle: string;
  type: ReleaseType;

  year?: number;

  season?: number;
  episode?: number;
  episodeEnd?: number;

  quality: ReleaseQuality;
  source?: string;
  codec?: string;
  audio?: string;

  isPack: boolean;
  isSeasonPack: boolean;
  isEpisodePack: boolean;

  flags: string[];
  tokens: string[];
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function firstNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function detectQuality(title: string): ReleaseQuality {
  const lower = title.toLowerCase();

  if (/\b(2160p|4k|uhd)\b/.test(lower)) return '2160p';
  if (/\b1080p\b/.test(lower)) return '1080p';
  if (/\b720p\b/.test(lower)) return '720p';
  if (/\b480p\b/.test(lower)) return '480p';

  return 'unknown';
}

function detectSource(title: string): string | undefined {
  const lower = title.toLowerCase();

  if (/\bweb[- .]?dl\b/.test(lower)) return 'WEB-DL';
  if (/\bwebrip\b/.test(lower)) return 'WEBRip';
  if (/\bbluray\b|\bblu[- .]?ray\b/.test(lower)) return 'BluRay';
  if (/\bhdtv\b/.test(lower)) return 'HDTV';
  if (/\bdvdrip\b/.test(lower)) return 'DVDRip';
  if (/\bcam\b/.test(lower)) return 'CAM';

  return undefined;
}

function detectCodec(title: string): string | undefined {
  const lower = title.toLowerCase();

  if (/\bx265\b|\bhevc\b|\bh\.265\b/.test(lower)) return 'x265';
  if (/\bx264\b|\bh\.264\b/.test(lower)) return 'x264';
  if (/\bav1\b/.test(lower)) return 'AV1';

  return undefined;
}

function detectAudio(title: string): string | undefined {
  const lower = title.toLowerCase();

  if (/\batmos\b/.test(lower)) return 'Atmos';
  if (/\btruehd\b/.test(lower)) return 'TrueHD';
  if (/\bdts\b/.test(lower)) return 'DTS';
  if (/\bddp?\b|\beac3\b/.test(lower)) return 'DDP';
  if (/\baac\b/.test(lower)) return 'AAC';

  return undefined;
}

function stripNoise(title: string): string {
  return title
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\([^)]+\)/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|4k|uhd)\b/gi, ' ')
    .replace(/\b(web[- .]?dl|webrip|bluray|blu[- .]?ray|hdtv|dvdrip|cam)\b/gi, ' ')
    .replace(/\b(x264|x265|h\.264|h\.265|hevc|av1)\b/gi, ' ')
    .replace(/\b(atmos|truehd|dts|ddp|eac3|aac)\b/gi, ' ')
    .replace(/\b(extended|proper|repack|remux|hdr|dv|dolby|vision|10bit|8bit)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseReleaseTitle(title: string): ParsedReleaseTitle {
  const raw = String(title || '');
  const cleaned = raw
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const lower = cleaned.toLowerCase();
  const flags: string[] = [];

  const quality = detectQuality(cleaned);
  const source = detectSource(cleaned);
  const codec = detectCodec(cleaned);
  const audio = detectAudio(cleaned);

  const yearMatch = cleaned.match(/\b(19\d{2}|20\d{2})\b/);
  const year = firstNumber(yearMatch?.[1]);

  const seasonEpisodeMatch =
    cleaned.match(/\bS(\d{1,2})E(\d{1,3})(?:\s?[-–]\s?E?(\d{1,3}))?\b/i) ||
    cleaned.match(/\b(\d{1,2})x(\d{1,3})(?:\s?[-–]\s?(\d{1,3}))?\b/i);

  const seasonOnlyMatch =
    cleaned.match(/\bS(\d{1,2})\b(?!\s?E\d{1,3})/i) ||
    cleaned.match(/\bSeason\s?(\d{1,2})\b/i);

  const season = firstNumber(seasonEpisodeMatch?.[1] || seasonOnlyMatch?.[1]);
  const episode = firstNumber(seasonEpisodeMatch?.[2]);
  const episodeEnd = firstNumber(seasonEpisodeMatch?.[3]);

  const isPack =
    /\b(pack|complete|collection|season|series)\b/i.test(cleaned) ||
    /\bS\d{1,2}\b/i.test(cleaned) && !/\bS\d{1,2}E\d{1,3}\b/i.test(cleaned);

  const isSeasonPack = Boolean(season && !episode && isPack);
  const isEpisodePack = Boolean(season && episode && episodeEnd && episodeEnd > episode);

  if (/\bproper\b/i.test(cleaned)) flags.push('proper');
  if (/\brepack\b/i.test(cleaned)) flags.push('repack');
  if (/\bextended\b/i.test(cleaned)) flags.push('extended');
  if (/\bremux\b/i.test(cleaned)) flags.push('remux');
  if (/\bhdr\b/i.test(cleaned)) flags.push('hdr');
  if (/\bdv\b|\bdolby vision\b/i.test(cleaned)) flags.push('dolby-vision');

  let type: ReleaseType = 'unknown';
  if (season && episode) type = 'episode';
  else if (season && isSeasonPack) type = 'season-pack';
  else if (year) type = 'movie';

  let titlePart = stripNoise(cleaned);

  if (seasonEpisodeMatch?.[0]) {
    titlePart = titlePart.split(seasonEpisodeMatch[0])[0] || titlePart;
  } else if (seasonOnlyMatch?.[0]) {
    titlePart = titlePart.split(seasonOnlyMatch[0])[0] || titlePart;
  } else if (yearMatch?.[0]) {
    titlePart = titlePart.split(yearMatch[0])[0] || titlePart;
  }

  const normalizedTitle = normalizeText(titlePart || cleaned);
  const tokens = unique(normalizedTitle.split(' ').filter(Boolean));

  return {
    raw,
    cleaned,
    normalizedTitle,
    type,
    year,
    season,
    episode,
    episodeEnd,
    quality,
    source,
    codec,
    audio,
    isPack,
    isSeasonPack,
    isEpisodePack,
    flags: unique(flags),
    tokens,
  };
}
