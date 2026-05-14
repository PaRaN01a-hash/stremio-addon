import axios from 'axios';
import { Stream, StreamMeta } from '../types';
import { logger } from '../utils/logger';

function envUrlList(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

function addonManifestUrls(): string[] {
  return [
    ...envUrlList('EXTERNAL_STREAM_ADDONS'),
    ...envUrlList('STREAMTHRU_MANIFEST_URLS'),
  ].filter((url, index, all) => all.indexOf(url) === index);
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

function normalizeTitleText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function externalStreamMatchesMeta(stream: Stream, meta: StreamMeta): boolean {
  // Only strict-filter series. Movies can keep the old behaviour.
  if (meta.type !== 'series') return true;

  const imdbTitleFallbacks: Record<string, string> = {
    // Broad one-word titles need exact guarding, otherwise external addons match spin-offs / unrelated shows.
    tt0108778: 'Friends',
  };

  const expected = normalizeTitleText(
    (meta as any).title ||
    (meta as any).name ||
    (meta as any).showName ||
    imdbTitleFallbacks[meta.imdbId] ||
    ''
  );

  // If meta has no title/name, avoid over-filtering.
  if (!expected) return true;

  const filename = normalizeTitleText((stream as any).filename || '');
  const title = normalizeTitleText((stream as any).title || '');
  const description = normalizeTitleText((stream as any).description || '');
  const name = normalizeTitleText((stream as any).name || '');

  const values = [filename, title, description, name].filter(Boolean);
  const expectedWords = expected.split(' ').filter(Boolean);

  // Multi-word shows are distinctive enough to use phrase containment.
  if (expectedWords.length > 1) {
    return values.some((v) => v.includes(expected));
  }

  // One-word shows like "Friends" must START with the title.
  // Blocks: "Smiling Friends", "Your Friends and Neighbors", "A Spy Among Friends".
  const startsWithExpected = (v: string) =>
    v === expected ||
    v.startsWith(expected + ' ') ||
    v.startsWith('the ' + expected + ' ');

  return values.some(startsWithExpected);
}

export async function getExternalAddonStreams(meta: StreamMeta): Promise<Stream[]> {
  const manifests = addonManifestUrls();
  if (!manifests.length) return [];

  const results = await Promise.allSettled(
    manifests.map(async (manifestUrl) => {
      const sourceName = sourceNameFromUrl(manifestUrl);
      const url = streamUrlFromManifest(manifestUrl, meta);

      const res = await axios.get(url, { timeout: 2500 });
      const streams = Array.isArray(res.data?.streams) ? res.data.streams : [];

      logger.info(`External addon ${sourceName}: ${streams.length} streams`);

      return streams
        .filter((s: Stream) => {
          const text = [
            s.name || '',
            s.title || '',
            String((s as any).description || ''),
            String((s as any).filename || ''),
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
        .filter((s: Stream) => externalStreamMatchesMeta(s, meta))
        .map((s: Stream) => labelStream(s, sourceName));
    })
  );

  return results.flatMap((r) => {
    if (r.status === 'fulfilled') return r.value;
    logger.warn('External addon failed', { err: r.reason?.message });
    return [];
  });
}
