const { parseReleaseTitle } = require('../dist/utils/release-parser');
const { scoreReleaseMatch } = require('../dist/utils/match-score');

const [
  ,
  ,
  type = 'series',
  title = '',
  seasonArg = '',
  episodeArg = '',
  ...releaseParts
] = process.argv;

const releaseTitle = releaseParts.join(' ');

if (!title || !releaseTitle) {
  console.error(`
Usage:
  node scripts/test-match-score.js <movie|series> "<title>" <season> <episode> "<release title>"

Examples:
  node scripts/test-match-score.js series "Friends" 1 1 "Smiling.Friends.S01E01.1080p.WEB-DL"
  node scripts/test-match-score.js series "From" 1 1 "From.S01E03.1080p.WEB-DL"
  node scripts/test-match-score.js movie "The Dark Knight" "" "" "The.Dark.Knight.2008.1080p.BluRay.x265"
`);
  process.exit(1);
}

const meta = {
  type,
  title,
  season: seasonArg === '' ? undefined : Number(seasonArg),
  episode: episodeArg === '' ? undefined : Number(episodeArg),
};

const parsed = parseReleaseTitle(releaseTitle);
const scored = scoreReleaseMatch(parsed, meta);

console.log(JSON.stringify({
  input: {
    releaseTitle,
    meta,
  },
  parsed,
  scored,
}, null, 2));
