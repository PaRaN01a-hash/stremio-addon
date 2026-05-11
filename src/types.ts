// src/types.ts

export interface StreamMeta {
  id: string;           // Stremio ID e.g. "tt1234567" or "tt1234567:1:2"
  type: 'movie' | 'series';
  imdbId: string;
  season?: number;
  episode?: number;
}

export interface Stream {
  name: string;         // Provider label shown in UI
  title: string;        // Detail line: quality, size, source
  url: string;          // Direct URL or debrid link
  behaviorHints?: {
    bingeGroup?: string;
    notWebReady?: boolean;
    proxyHeaders?: {
      request?: Record<string, string>;
    };
  };
}

export interface TorrentResult {
  title: string;
  infoHash: string;
  magnetUrl?: string;
  size: number;         // bytes
  seeders: number;
  quality: string;      // parsed: 4K, 1080p, 720p, etc.
  source: string;       // indexer name
  hdr?: boolean;
  dolbyVision?: boolean;
}

export interface DebridResult {
  cached: boolean;
  streamUrl?: string;
  torrent: TorrentResult;
}

export interface HttpStream {
  name: string;
  url: string;
  quality: string;
  source: string;
  headers?: Record<string, string>;
}

export interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttl: number;
}

export type StreamSource = 'debrid' | 'torrent' | 'http';
