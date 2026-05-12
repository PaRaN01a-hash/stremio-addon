import { NormalizedStream } from './types';
import { scoreStream } from './score';

function keyFor(s: NormalizedStream): string {
  return [
    s.quality || 'unknown',
    s.codec || 'unknown',
    s.hdr ? 'hdr' : 'sdr',
    s.dolbyVision ? 'dv' : 'nodv',
    s.releaseGroup || s.provider || 'unknown',
  ].join('|').toLowerCase();
}

export function dedupeStreams(streams: NormalizedStream[]): NormalizedStream[] {
  const best = new Map<string, NormalizedStream>();

  for (const stream of streams) {
    const key = keyFor(stream);
    const existing = best.get(key);

    if (!existing || scoreStream(stream) > scoreStream(existing)) {
      best.set(key, stream);
    }
  }

  return [...best.values()];
}
