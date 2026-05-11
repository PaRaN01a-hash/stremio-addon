// src/addon.ts
import { getStreams } from './providers/streams';
import { StreamMeta } from './types';
import { logger } from './utils/logger';

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

/**
 * Handle a stream request from Stremio/Nuvio.
 */
export async function streamHandler(
  type: string,
  id: string
): Promise<{ streams: ReturnType<typeof getStreams> extends Promise<infer T> ? T : never }> {
  logger.info(`Stream request: ${type} ${id}`);
  const meta = parseStremioId(id, type);
  const streams = await getStreams(meta);
  return { streams } as any;
}
