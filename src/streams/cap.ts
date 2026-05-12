import { NormalizedStream } from './types';
import { scoreStream } from './score';

const MAX_PER_QUALITY = parseInt(process.env.MAX_STREAMS_PER_QUALITY || '4', 10);

export function capStreamsPerQuality(streams: NormalizedStream[]): NormalizedStream[] {
  const buckets = new Map<string, NormalizedStream[]>();

  for (const stream of streams) {
    const key = (stream.quality || 'unknown').toLowerCase();
    const list = buckets.get(key) || [];
    list.push(stream);
    buckets.set(key, list);
  }

  const out: NormalizedStream[] = [];

  for (const list of buckets.values()) {
    out.push(
      ...list
        .sort((a, b) => scoreStream(b) - scoreStream(a))
        .slice(0, MAX_PER_QUALITY)
    );
  }

  return out;
}
