import { NormalizedStream } from './types';
import { scoreStream } from './score';

const DEFAULT_PROVIDER_CAP = parseInt(process.env.MAX_STREAMS_PER_PROVIDER || '12', 10);

function providerCap(provider: string): number {
  const p = (provider || '').toLowerCase();

  if (p.includes('maximus') || p.includes('tb+')) {
    return parseInt(process.env.MAX_MAXIMUS_STREAMS || '12', 10);
  }

  if (p.includes('comet')) {
    return parseInt(process.env.MAX_COMET_STREAMS || '6', 10);
  }

  if (p.includes('hdhub')) {
    return parseInt(process.env.MAX_HDHUB_STREAMS || '2', 10);
  }

  return DEFAULT_PROVIDER_CAP;
}

export function capStreamsPerProvider(streams: NormalizedStream[]): NormalizedStream[] {
  const buckets = new Map<string, NormalizedStream[]>();

  for (const stream of streams) {
    const key = (stream.source || stream.provider || 'unknown').toLowerCase();
    const list = buckets.get(key) || [];
    list.push(stream);
    buckets.set(key, list);
  }

  const out: NormalizedStream[] = [];

  for (const [provider, list] of buckets.entries()) {
    out.push(
      ...list
        .sort((a, b) => scoreStream(b) - scoreStream(a))
        .slice(0, providerCap(provider))
    );
  }

  return out;
}
