import type { StreamCandidate } from './stream-candidate';

export interface CandidateSortOptions {
  preferCached?: boolean;
  preferParseable?: boolean;
  preferMatched?: boolean;
}

function qualityRank(candidate: StreamCandidate): number {
  const text = [
    candidate.quality,
    candidate.name,
    candidate.title,
    candidate.filename,
    candidate.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (text.includes('2160') || text.includes('4k')) return 400;
  if (text.includes('1080')) return 300;
  if (text.includes('720')) return 200;
  if (text.includes('480')) return 100;

  return 0;
}

function sourceRank(candidate: StreamCandidate): number {
  const text = [
    candidate.source,
    candidate.name,
    candidate.title,
    candidate.filename,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let score = 0;

  if (text.includes('web-dl') || text.includes('webdl')) score += 40;
  if (text.includes('webrip')) score += 30;
  if (text.includes('bluray') || text.includes('blu-ray')) score += 35;
  if (text.includes('hdtv')) score += 15;
  if (text.includes('cam')) score -= 200;

  if (text.includes('remux')) score -= 60;
  if (text.includes('dv') || text.includes('dolby vision')) score -= 15;

  return score;
}

function sizeRank(candidate: StreamCandidate): number {
  const size = candidate.size || 0;
  if (!size) return 0;

  const gb = size / 1024 / 1024 / 1024;

  if (gb >= 2 && gb <= 15) return 50;
  if (gb > 15 && gb <= 30) return 10;
  if (gb > 30) return -80;

  return 0;
}

function cacheRank(candidate: StreamCandidate): number {
  if (candidate.cache?.cached) return 300;
  if (candidate.sourceType === 'cached') return 250;
  return 0;
}

function matchRank(candidate: StreamCandidate): number {
  const decision = candidate.match?.decision;

  if (decision === 'accept') return 200 + (candidate.match?.score || 0);
  if (decision === 'maybe') return 75 + (candidate.match?.score || 0);
  if (decision === 'unscored') return 10;
  if (decision === 'reject') return -500;

  return 0;
}

function providerRank(candidate: StreamCandidate): number {
  switch (candidate.provider) {
    case 'torbox':
      return 120;
    case 'zilean':
      return 100;
    case 'jackett':
      return 80;
    case 'local-index':
      return 150;
    case 'external-stremio':
      return 40;
    case 'external-addon':
      return 30;
    case 'hdhub':
    case 'hdbub':
      return 20;
    default:
      return 0;
  }
}

export function candidateSortScore(
  candidate: StreamCandidate,
  options: CandidateSortOptions = {}
): number {
  let score = 0;

  score += providerRank(candidate);
  score += qualityRank(candidate);
  score += sourceRank(candidate);
  score += sizeRank(candidate);

  if (options.preferCached !== false) {
    score += cacheRank(candidate);
  }

  if (options.preferMatched !== false) {
    score += matchRank(candidate);
  }

  if (options.preferParseable !== false && candidate.parseable) {
    score += 25;
  }

  if (candidate.seeders) {
    score += Math.min(candidate.seeders, 200);
  }

  return score;
}

export function sortCandidates<T extends StreamCandidate>(
  candidates: T[],
  options: CandidateSortOptions = {}
): T[] {
  return [...candidates].sort((a, b) => {
    const scoreDelta = candidateSortScore(b, options) - candidateSortScore(a, options);
    if (scoreDelta !== 0) return scoreDelta;

    const sizeDelta = (b.size || 0) - (a.size || 0);
    if (sizeDelta !== 0) return sizeDelta;

    return String(a.name || a.title || '').localeCompare(String(b.name || b.title || ''));
  });
}

export function bucketCandidate(candidate: StreamCandidate): string {
  const quality = qualityRank(candidate);

  if (candidate.match?.decision === 'reject') return 'rejected';
  if (candidate.match?.decision === 'unscored') return 'unscored';

  if (quality >= 400) return '4k';
  if (quality >= 300) return '1080p';
  if (quality >= 200) return '720p';
  if (quality >= 100) return '480p';

  return 'unknown';
}
