import type { ParsedReleaseTitle } from '../utils/release-parser';
import type { ReleaseMatchScore } from '../utils/match-score';

export type StreamCandidateProvider =
  | 'zilean'
  | 'jackett'
  | 'torbox'
  | 'hdbub'
  | 'hdhub'
  | 'external-stremio'
  | 'external-addon'
  | 'http-fallback'
  | 'local-index'
  | 'unknown';

export type StreamCandidateSourceType =
  | 'torrent'
  | 'http'
  | 'external'
  | 'cached'
  | 'unknown';

export type StreamCandidateMatchSource =
  | 'filename'
  | 'title'
  | 'name'
  | 'none';

export interface StreamCandidateCacheState {
  provider?: string;
  cached?: boolean;
  checked?: boolean;
  resolvedUrl?: string;
}

export interface StreamCandidate {
  id: string;

  provider: StreamCandidateProvider;
  sourceType: StreamCandidateSourceType;

  name?: string;
  title?: string;
  filename?: string;
  description?: string;

  infoHash?: string;
  url?: string;

  size?: number;
  seeders?: number;
  quality?: string;
  source?: string;
  releaseGroup?: string;

  season?: number;
  episode?: number;

  matchSource?: StreamCandidateMatchSource;
  parseable?: boolean;
  parsedRelease?: ParsedReleaseTitle;
  match?: ReleaseMatchScore | {
    score: number;
    decision: 'unscored';
    reasons: string[];
    penalties: string[];
  };

  cache?: StreamCandidateCacheState;

  raw?: unknown;
}

export function candidateIdentity(candidate: StreamCandidate): string {
  return [
    candidate.provider,
    candidate.infoHash || '',
    candidate.url || '',
    candidate.filename || candidate.title || candidate.name || '',
  ]
    .join('|')
    .toLowerCase();
}

export function isTorrentCandidate(candidate: StreamCandidate): boolean {
  return Boolean(candidate.infoHash || candidate.sourceType === 'torrent');
}

export function isPlayableCandidate(candidate: StreamCandidate): boolean {
  return Boolean(candidate.url || candidate.infoHash || candidate.cache?.resolvedUrl);
}
