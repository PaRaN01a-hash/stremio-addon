import axios from 'axios';
import { Stream, StreamMeta } from '../types';
import { logger } from '../utils/logger';

function addonManifestUrls(): string[] {
  return (process.env.EXTERNAL_STREAM_ADDONS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function streamUrlFromManifest(manifestUrl: string, meta: StreamMeta): string {
  const base = manifestUrl.replace(/\/manifest\.json$/, '');
  const id =
    meta.type === 'series' && meta.season !== undefined && meta.episode !== undefined
      ? `${meta.imdbId}:${meta.season}:${meta.episode}`
      : meta.imdbId;

  return `${base}/stream/${meta.type}/${encodeURIComponent(id)}.json`;
}

function labelStream(stream: Stream, sourceName: string): Stream {
  return {
    ...stream,
    name: stream.name ? `[${sourceName}] ${stream.name}` : `[${sourceName}]`,
  };
}

function sourceNameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (host.includes('comet')) return 'Comet';
    if (host.includes('nuvio')) return 'Nuvio';
    if (host.includes('hdhub')) return 'HDHub';
    return host.split('.')[0] || 'External';
  } catch {
    return 'External';
  }
}

export async function getExternalAddonStreams(meta: StreamMeta): Promise<Stream[]> {
  const manifests = addonManifestUrls();
  if (!manifests.length) return [];

  const results = await Promise.allSettled(
    manifests.map(async (manifestUrl) => {
      const sourceName = sourceNameFromUrl(manifestUrl);
      const url = streamUrlFromManifest(manifestUrl, meta);

      const res = await axios.get(url, { timeout: 7000 });
      const streams = Array.isArray(res.data?.streams) ? res.data.streams : [];

      logger.info(`External addon ${sourceName}: ${streams.length} streams`);

      return streams
        .filter((s: Stream) => {
          const text = [
            s.name || '',
            s.title || '',
            String((s as any).description || ''),
            s.url || '',
          ].join(' ').toLowerCase();

          return !(
            text.includes('comet sync') ||
            text.includes('sync debrid') ||
            text.includes('debrid-sync') ||
            text.includes('debrid account library') ||
            text.includes('select this stream')
          );
        })
        .map((s: Stream) => labelStream(s, sourceName));
    })
  );

  return results.flatMap((r) => {
    if (r.status === 'fulfilled') return r.value;
    logger.warn('External addon failed', { err: r.reason?.message });
    return [];
  });
}
