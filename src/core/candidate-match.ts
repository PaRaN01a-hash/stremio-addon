import { parseReleaseTitle } from '../utils/release-parser';
import { scoreReleaseMatch, MatchMeta } from '../utils/match-score';
import type {
  StreamCandidate,
  StreamCandidateMatchSource,
} from './stream-candidate';

export interface CandidateReleaseSelection {
  matchSource: StreamCandidateMatchSource;
  releaseTitle: string;
  parseable: boolean;
}

export interface CandidateMatchResult {
  candidate: StreamCandidate;
  selection: CandidateReleaseSelection;
}

export function selectBestReleaseTitle(candidate: Pick<StreamCandidate, 'filename' | 'title' | 'name'>): CandidateReleaseSelection {
  const releaseCandidates: Array<{ source: StreamCandidateMatchSource; value?: string }> = [
    { source: 'filename', value: candidate.filename },
    { source: 'title', value: candidate.title },
    { source: 'name', value: candidate.name },
  ];

  for (const option of releaseCandidates) {
    const value = String(option.value || '').trim();
    if (!value) continue;

    const parsed = parseReleaseTitle(value);
    const parseable = Boolean(
      parsed.normalizedTitle ||
      parsed.season !== undefined ||
      parsed.episode !== undefined ||
      parsed.year !== undefined
    );

    if (parseable) {
      return {
        matchSource: option.source,
        releaseTitle: value,
        parseable: true,
      };
    }
  }

  return {
    matchSource: 'none',
    releaseTitle: '',
    parseable: false,
  };
}

export function scoreStreamCandidate(
  candidate: StreamCandidate,
  meta: MatchMeta
): StreamCandidate {
  const selection = selectBestReleaseTitle(candidate);
  const parsedRelease = parseReleaseTitle(selection.releaseTitle);

  const match = meta.title && selection.parseable
    ? scoreReleaseMatch(parsedRelease, meta)
    : {
        score: 0,
        decision: 'unscored' as const,
        reasons: [],
        penalties: [
          meta.title
            ? 'no-parseable-release-title'
            : 'missing-expected-title',
        ],
      };

  return {
    ...candidate,
    matchSource: selection.matchSource,
    parseable: selection.parseable,
    filename: candidate.filename,
    parsedRelease,
    match,
  };
}
