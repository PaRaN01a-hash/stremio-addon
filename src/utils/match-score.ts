import type { ParsedReleaseTitle } from './release-parser';

export interface MatchMeta {
  type?: 'movie' | 'series' | string;
  title?: string;
  name?: string;
  originalTitle?: string;
  year?: number | string;
  season?: number | string;
  episode?: number | string;
  aliases?: string[];
}

export interface ReleaseMatchScore {
  score: number;
  decision: 'accept' | 'maybe' | 'reject';
  reasons: string[];
  penalties: string[];
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

function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(' ')
      .filter(Boolean)
  );
}

function tokenOverlapScore(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);

  if (!left.size || !right.size) return 0;

  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap++;
  }

  return overlap / Math.max(left.size, right.size);
}

function titleCandidates(meta: MatchMeta): string[] {
  return [
    meta.title,
    meta.name,
    meta.originalTitle,
    ...(meta.aliases || []),
  ]
    .filter(Boolean)
    .map(String);
}

export function scoreReleaseMatch(
  parsed: ParsedReleaseTitle,
  meta: MatchMeta
): ReleaseMatchScore {
  let score = 0;
  const reasons: string[] = [];
  const penalties: string[] = [];

  const metaType = String(meta.type || '').toLowerCase();
  const metaYear = asNumber(meta.year);
  const metaSeason = asNumber(meta.season);
  const metaEpisode = asNumber(meta.episode);

  const candidates = titleCandidates(meta);
  const bestTitleScore = candidates.reduce((best, candidate) => {
    return Math.max(best, tokenOverlapScore(parsed.normalizedTitle, candidate));
  }, 0);

  if (bestTitleScore >= 0.95) {
    score += 45;
    reasons.push('exact-title-token-match');
  } else if (bestTitleScore >= 0.75) {
    score += 32;
    reasons.push('strong-title-token-match');
  } else if (bestTitleScore >= 0.5) {
    score += 18;
    reasons.push('partial-title-token-match');
  } else {
    score -= 45;
    penalties.push('weak-title-token-match');
  }

  if (metaType === 'movie') {
    if (parsed.type === 'movie' || parsed.type === 'unknown') {
      score += 10;
      reasons.push('movie-compatible-release');
    }

    if (parsed.season || parsed.episode) {
      score -= 60;
      penalties.push('episode-markers-on-movie');
    }

    if (metaYear && parsed.year) {
      const yearDelta = Math.abs(metaYear - parsed.year);

      if (yearDelta === 0) {
        score += 20;
        reasons.push('exact-year-match');
      } else if (yearDelta === 1) {
        score += 5;
        reasons.push('near-year-match');
      } else {
        score -= 25;
        penalties.push('wrong-year');
      }
    }
  }

  if (metaType === 'series') {
    if (parsed.type === 'episode') {
      score += 15;
      reasons.push('episode-compatible-release');
    }

    if (parsed.isSeasonPack) {
      score += 22;
      reasons.push('season-pack-allowed');
    }

    if (metaSeason !== undefined && parsed.season !== undefined) {
      if (metaSeason === parsed.season) {
        score += 25;
        reasons.push('season-match');
      } else {
        score -= 70;
        penalties.push('wrong-season');
      }
    }

    if (
      metaEpisode !== undefined &&
      parsed.episode !== undefined &&
      !parsed.isSeasonPack
    ) {
      const episodeEnd = parsed.episodeEnd || parsed.episode;
      const episodeInsideRange =
        metaEpisode >= parsed.episode && metaEpisode <= episodeEnd;

      if (episodeInsideRange) {
        score += 30;
        reasons.push(
          parsed.episodeEnd ? 'episode-range-match' : 'episode-match'
        );
      } else {
        score -= 75;
        penalties.push('wrong-episode');
      }
    }

    if (
      metaEpisode !== undefined &&
      parsed.episode === undefined &&
      !parsed.isSeasonPack
    ) {
      score -= 20;
      penalties.push('missing-episode-marker');
    }
  }

  if (parsed.quality !== 'unknown') {
    score += 3;
    reasons.push(`quality-${parsed.quality}`);
  }

  if (parsed.source) {
    score += 2;
    reasons.push(`source-${parsed.source}`);
  }

  if (parsed.flags.includes('proper') || parsed.flags.includes('repack')) {
    score += 2;
    reasons.push('trusted-fix-release');
  }

  if (parsed.flags.includes('remux')) {
    score += 2;
    reasons.push('remux');
  }

  const clamped = Math.max(0, Math.min(100, score));

  let decision: ReleaseMatchScore['decision'] = 'maybe';
  if (clamped >= 60 && penalties.length === 0) decision = 'accept';
  if (clamped >= 70 && !penalties.includes('wrong-season') && !penalties.includes('wrong-episode')) {
    decision = 'accept';
  }
  if (
    clamped < 45 ||
    penalties.includes('wrong-season') ||
    penalties.includes('wrong-episode') ||
    penalties.includes('episode-markers-on-movie')
  ) {
    decision = 'reject';
  }

  return {
    score: clamped,
    decision,
    reasons,
    penalties,
  };
}
