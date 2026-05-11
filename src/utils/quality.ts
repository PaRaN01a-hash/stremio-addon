// src/utils/quality.ts

const QUALITY_PATTERNS: Array<{ pattern: RegExp; label: string; rank: number }> = [
  { pattern: /\b(2160p|4k|uhd)\b/i,    label: '4K',    rank: 5 },
  { pattern: /\b1080p\b/i,             label: '1080p', rank: 4 },
  { pattern: /\b1080i\b/i,             label: '1080i', rank: 3 },
  { pattern: /\b720p\b/i,              label: '720p',  rank: 2 },
  { pattern: /\b480p\b/i,              label: '480p',  rank: 1 },
  { pattern: /\bsd\b/i,                label: 'SD',    rank: 0 },
];

export function parseQuality(title: string): { label: string; rank: number } {
  for (const { pattern, label, rank } of QUALITY_PATTERNS) {
    if (pattern.test(title)) return { label, rank };
  }
  return { label: 'Unknown', rank: -1 };
}

export function parseHDR(title: string): boolean {
  return /\b(hdr|hdr10|hdr10\+|hlg)\b/i.test(title);
}

export function parseDolbyVision(title: string): boolean {
  return /\b(dv|dolby.?vision)\b/i.test(title);
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return '';
  const gb = bytes / 1_073_741_824;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1_048_576;
  return `${mb.toFixed(0)} MB`;
}

export function buildStreamTitle(
  quality: string,
  size: number,
  seeders: number,
  source: string,
  hdr: boolean,
  dv: boolean
): string {
  const parts: string[] = [quality];
  if (dv) parts.push('DV');
  else if (hdr) parts.push('HDR');
  if (size) parts.push(formatSize(size));
  parts.push(`👥 ${seeders}`);
  parts.push(`📦 ${source}`);
  return parts.join(' · ');
}
