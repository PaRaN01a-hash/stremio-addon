import axios from 'axios';
import { Stream } from '../types';

const ADDONS = (process.env.EXTERNAL_STREMIO_ADDONS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function streamUrlFromManifest(manifestUrl: string, type: string, id: string): string {
  const clean = manifestUrl.replace(/\/manifest\.json$/, '').replace(/\/$/, '');
  return `${clean}/stream/${type}/${id}.json`;
}

export async function getExternalStremioStreams(
  type: string,
  id: string,
  season?: number,
  episode?: number
): Promise<Stream[]> {
  const out: Stream[] = [];

  for (const addon of ADDONS) {
    try {
      let streamId = id;

      if (type === 'series' && season !== undefined && episode !== undefined) {
        streamId = `${id}:${season}:${episode}`;
      }

      const url = streamUrlFromManifest(addon, type, streamId);
      const res = await axios.get(url, {
        timeout: parseInt(process.env.EXTERNAL_STREMIO_TIMEOUT || '8000', 10),
        headers: {
          'user-agent': 'MaximusStreams/1.0',
          'accept': 'application/json',
        },
      });

      const streams = Array.isArray(res.data?.streams) ? res.data.streams : [];

      for (const s of streams) {
        if (!s) continue;

        out.push({
          name: s.name || s.title || 'External Stremio',
          title: s.title || s.name || 'External Stremio',
          url: s.url,
          infoHash: s.infoHash,
          fileIdx: s.fileIdx,
          behaviorHints: s.behaviorHints,
        } as Stream);
      }

    } catch (err: any) {
      console.warn('External Stremio failed:', addon, err?.message || err);
    }
  }

  return out;
}
