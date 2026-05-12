import { NormalizedStream } from './types';

const MAX_STREAMS_TOTAL =
  parseInt(process.env.MAX_STREAMS_TOTAL || '25');

const MAX_SIZE_GB =
  parseFloat(process.env.MAX_SIZE_GB || '20');

const ALLOW_CAM =
  process.env.ALLOW_CAM === 'true';

export function filterStreams(
  streams: NormalizedStream[]
): NormalizedStream[] {

  let out = streams.filter(s => {
    const gb = s.size / 1024 / 1024 / 1024;

    if (gb > MAX_SIZE_GB) return false;

    const title = s.title.toLowerCase();

    if (!ALLOW_CAM) {
      if (
        title.includes(' cam ') ||
        title.includes(' hdcam ') ||
        title.includes(' telesync ') ||
        title.includes(' ts ')
      ) {
        return false;
      }
    }

    return true;
  });

  return out.slice(0, MAX_STREAMS_TOTAL);
}
