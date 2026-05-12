import { NormalizedStream } from './types';

function qualityRank(q: string): number {
  const key = (q || '').toLowerCase();
  if (key.includes('4k') || key.includes('2160')) return 500;
  if (key.includes('1080')) return 400;
  if (key.includes('720')) return 300;
  if (key.includes('480')) return 200;
  return 100;
}

export function scoreStream(s: NormalizedStream): number {
  let score = 0;

  score += qualityRank(s.quality);

  if (s.cached) score += 1000;
  if (s.dolbyVision) score += 80;
  if (s.hdr) score += 50;

  const title = s.title.toLowerCase();

  if (title.includes('web-dl')) score += 80;
  if (title.includes('bluray')) score += 60;
  if (title.includes('remux')) score += 40;
  if (title.includes('x265') || title.includes('hevc')) score += 30;
  if (title.includes('atmos')) score += 20;

  if (title.includes('cam') || title.includes('hdcam') || title.includes('telesync')) score -= 1000;

  const gb = s.size / 1024 / 1024 / 1024;
  if (gb >= 2 && gb <= 12) score += 80;
  if (gb > 20) score -= 150;
  if (gb < 0.3) score -= 100;

  score += Math.min(s.seeders || 0, 200);

  return score;
}

export function sortStreams(streams: NormalizedStream[]): NormalizedStream[] {
  return [...streams].sort((a, b) => scoreStream(b) - scoreStream(a));
}
