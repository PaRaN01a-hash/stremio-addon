export interface NormalizedStream {
  id: string;

  provider: string;
  source: string;

  title: string;
  releaseGroup?: string;

  infoHash?: string;
  url: string;

  quality: string;
  codec?: string;

  hdr?: boolean;
  dolbyVision?: boolean;

  size: number;
  seeders: number;

  cached: boolean;

  season?: number;
  episode?: number;

  bingeGroup?: string;

  raw?: any;
}
