// src/addon.ts
import { getStreams } from './providers/streams';
import { StreamMeta } from './types';
import { logger } from './utils/logger';
import { getTitleFromTmdb } from './jackett';

export const manifest = {
  id: process.env.ADDON_ID || 'com.personal.stremio-addon',
  version: process.env.ADDON_VERSION || '1.0.0',
  name: process.env.ADDON_NAME || 'Personal Addon',
  description: 'Personal Stremio addon: TorBox debrid + Jackett torrents + HTTP fallback. Instant loading via Redis cache.',
  logo: '',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],  // IMDB IDs only
  catalogs: [],        // No catalog — streams only
  behaviorHints: {
    adult: false,
    p2pNotSupported: false,  // We do serve debrid streams which are HTTP, but flag false for compatibility
  },
};

/**
 * Parse a Stremio content ID into its components.
 * Movies: "tt1234567"
 * Series: "tt1234567:1:2"
 */
function parseStremioId(id: string, type: string): StreamMeta {
  const parts = id.split(':');
  const imdbId = parts[0];

  if (type === 'series' && parts.length === 3) {
    return {
      id,
      type: 'series',
      imdbId,
      season: parseInt(parts[1]),
      episode: parseInt(parts[2]),
    };
  }

  return { id, type: type as 'movie' | 'series', imdbId };
}

async function enrichStreamMeta(meta: StreamMeta): Promise<StreamMeta> {
  try {
    const resolved = await getTitleFromTmdb(meta.imdbId, meta.type);
    if (!resolved) return meta;

    const yearMatch = resolved.match(/\b(19\d{2}|20\d{2})\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined;
    const title = resolved.replace(/\s+\b(19\d{2}|20\d{2})\b\s*$/, '').trim();

    return {
      ...meta,
      title: title || resolved,
      year,
    };
  } catch (err: any) {
    logger.warn('Metadata enrichment failed', { imdbId: meta.imdbId, err: err?.message || String(err) });
    return meta;
  }
}


/**
 * Handle a stream request from Stremio/Nuvio.
 */
export async function streamHandler(
  type: string,
  id: string
): Promise<{ streams: ReturnType<typeof getStreams> extends Promise<infer T> ? T : never }> {
  logger.info(`Stream request: ${type} ${id}`);
  const meta = await enrichStreamMeta(parseStremioId(id, type));
  const streams = await getStreams(meta);
  return { streams } as any;
}
