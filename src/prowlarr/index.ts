import axios from 'axios';
import crypto from 'crypto';
import { StreamMeta, TorrentResult } from '../types';
import { getTitleFromTmdb } from '../jackett';
import { parseQuality, parseHDR, parseDolbyVision } from '../utils/quality';
import { logger } from '../utils/logger';

interface ProwlarrRssItem {
  title: string;
  guid?: string;
  link?: string;
  enclosureUrl?: string;
  size?: number;
  seeders?: number;
  indexer?: string;
  infoHash?: string;
  magnetUrl?: string;
}

function prowlarrUrls(): string[] {
  return String(process.env.PROWLARR_TORZNAB_URLS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export function prowlarrConfigured(): boolean {
  return prowlarrUrls().length > 0;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function tagText(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1] ? decodeXml(match[1].trim()) : undefined;
}

function tagAttr(block: string, tag: string, attr: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]+)"[^>]*>`, 'i'));
  return match?.[1] ? decodeXml(match[1].trim()) : undefined;
}

function torznabAttrs(block: string): Record<string, string[]> {
  const attrs: Record<string, string[]> = {};
  const re = /<torznab:attr\s+([^>]+?)\/>/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(block))) {
    const raw = match[1] || '';
    const name = raw.match(/\bname="([^"]+)"/i)?.[1];
    const value = raw.match(/\bvalue="([^"]*)"/i)?.[1] || '';
    if (!name) continue;
    attrs[name] ||= [];
    attrs[name].push(decodeXml(value));
  }

  return attrs;
}

function parseRssItems(xml: string): ProwlarrRssItem[] {
  const items: ProwlarrRssItem[] = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(xml))) {
    const block = match[0];
    const attrs = torznabAttrs(block);
    const title = tagText(block, 'title') || '';

    if (!title.trim()) continue;

    items.push({
      title,
      guid: tagText(block, 'guid'),
      link: tagText(block, 'link'),
      enclosureUrl: tagAttr(block, 'enclosure', 'url'),
      size: Number(tagText(block, 'size') || tagAttr(block, 'enclosure', 'length') || 0),
      seeders: Number(attrs.seeders?.[0] || 0),
      indexer: tagText(block, 'prowlarrindexer'),
      infoHash: attrs.infohash?.[0] || attrs.infoHash?.[0],
      magnetUrl: attrs.magneturl?.[0] || attrs.magnetUrl?.[0],
    });
  }

  return items;
}

function base32ToHex(value: string): string | undefined {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = value.toUpperCase().replace(/=+$/g, '');

  if (!/^[A-Z2-7]{32}$/.test(clean)) return undefined;

  let bits = '';
  for (const char of clean) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) return undefined;
    bits += idx.toString(2).padStart(5, '0');
  }

  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }

  if (bytes.length !== 20) return undefined;
  return Buffer.from(bytes).toString('hex');
}

function normalizeInfoHash(value: unknown): string | undefined {
  const input = String(value || '').trim();
  if (!input) return undefined;

  const btih = input.match(/btih:([a-f0-9]{40}|[a-z2-7]{32})/i)?.[1];
  if (btih) {
    if (/^[a-f0-9]{40}$/i.test(btih)) return btih.toLowerCase();
    return base32ToHex(btih);
  }

  const hex = input.match(/\b[a-f0-9]{40}\b/i)?.[0];
  if (hex) return hex.toLowerCase();

  const base32 = input.match(/\b[a-z2-7]{32}\b/i)?.[0];
  if (base32) return base32ToHex(base32);

  return undefined;
}

function parseBencodeBytes(buffer: Buffer, pos: number): { text: string; next: number } {
  let colon = pos;
  while (colon < buffer.length && buffer[colon] !== 58) colon++; // :

  if (colon >= buffer.length) throw new Error('Invalid bencode string');
  const len = Number(buffer.slice(pos, colon).toString('ascii'));
  if (!Number.isFinite(len) || len < 0) throw new Error('Invalid bencode string length');

  const start = colon + 1;
  const end = start + len;
  if (end > buffer.length) throw new Error('Bencode string exceeds buffer');

  return { text: buffer.slice(start, end).toString('utf8'), next: end };
}

function parseBencodeValueEnd(buffer: Buffer, pos: number): number {
  const char = buffer[pos];

  if (char === 0x69) { // i
    const end = buffer.indexOf(0x65, pos + 1); // e
    if (end < 0) throw new Error('Invalid bencode integer');
    return end + 1;
  }

  if (char === 0x6c) { // l
    let cursor = pos + 1;
    while (cursor < buffer.length && buffer[cursor] !== 0x65) {
      cursor = parseBencodeValueEnd(buffer, cursor);
    }
    if (buffer[cursor] !== 0x65) throw new Error('Invalid bencode list');
    return cursor + 1;
  }

  if (char === 0x64) { // d
    let cursor = pos + 1;
    while (cursor < buffer.length && buffer[cursor] !== 0x65) {
      cursor = parseBencodeBytes(buffer, cursor).next;
      cursor = parseBencodeValueEnd(buffer, cursor);
    }
    if (buffer[cursor] !== 0x65) throw new Error('Invalid bencode dict');
    return cursor + 1;
  }

  if (char >= 0x30 && char <= 0x39) {
    return parseBencodeBytes(buffer, pos).next;
  }

  throw new Error('Unknown bencode value');
}

function torrentInfoHash(buffer: Buffer): string | undefined {
  if (buffer[0] !== 0x64) return undefined; // d

  let cursor = 1;
  while (cursor < buffer.length && buffer[cursor] !== 0x65) {
    const key = parseBencodeBytes(buffer, cursor);
    cursor = key.next;

    const valueStart = cursor;
    const valueEnd = parseBencodeValueEnd(buffer, cursor);

    if (key.text === 'info') {
      return crypto.createHash('sha1').update(buffer.slice(valueStart, valueEnd)).digest('hex');
    }

    cursor = valueEnd;
  }

  return undefined;
}

async function infoHashFromTorrentUrl(url: string, timeout: number): Promise<string | undefined> {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      timeout,
      responseType: 'arraybuffer',
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        'User-Agent': 'Maximus/3.4 Prowlarr Torznab',
        Accept: 'application/x-bittorrent,*/*',
      },
    });

    const locationHeader = response.headers?.location;
    const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;

    // Prowlarr commonly returns a 301/302 redirect to a magnet link.
    // Do not follow it as HTTP. Just harvest the btih hash from Location.
    const redirectedHash = normalizeInfoHash(location);
    if (redirectedHash) return redirectedHash;

    const buffer = Buffer.from(response.data as any);
    return torrentInfoHash(buffer);
  } catch (err: any) {
    logger.warn('Prowlarr torrent hash lookup failed', {
      err: err?.message || String(err),
    });
    return undefined;
  }
}

function buildQueries(title: string, meta: StreamMeta): string[] {
  const baseTitle = title.replace(/\s+\d{4}$/, '').trim();
  const queries: string[] = [];

  if (meta.type === 'series' && meta.season !== undefined && meta.episode !== undefined) {
    const sxx = `S${String(meta.season).padStart(2, '0')}`;
    const exx = `E${String(meta.episode).padStart(2, '0')}`;

    queries.push(`${title} ${sxx}${exx}`);
    queries.push(`${baseTitle} ${sxx}${exx}`);
    queries.push(`${title} Season ${meta.season}`);
    queries.push(`${baseTitle} Season ${meta.season}`);
    queries.push(`${baseTitle} ${sxx}`);
  } else {
    queries.push(title);
  }

  return [...new Set(queries.filter(Boolean))];
}

export async function searchProwlarr(meta: StreamMeta): Promise<TorrentResult[]> {
  const urls = prowlarrUrls();
  const timeout = parseInt(process.env.PROWLARR_TIMEOUT || '25000', 10);
  const maxResults = parseInt(process.env.PROWLARR_MAX_RESULTS || '40', 10);
  const maxHashLookups = parseInt(process.env.PROWLARR_TORRENT_HASH_LOOKUP_LIMIT || '16', 10);

  if (!urls.length) {
    logger.warn('Prowlarr not configured');
    return [];
  }

  const title = await getTitleFromTmdb(meta.imdbId, meta.type);
  if (!title) {
    logger.warn(`Could not resolve title for Prowlarr search ${meta.imdbId}`);
    return [];
  }

  const baseTitle = title.replace(/\s+\d{4}$/, '').trim();
  const titleNeedle = baseTitle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const queries = buildQueries(title, meta);
  const allItems: ProwlarrRssItem[] = [];

  for (const url of urls) {
    for (const query of queries) {
      try {
        logger.info(`Prowlarr searching: "${query}" for ${meta.imdbId}`);

        const response = await axios.get<string>(url, {
          timeout,
          responseType: 'text',
          maxRedirects: 5,
          params: {
            t: 'search',
            q: query,
          },
          headers: {
            'User-Agent': 'Maximus/3.4 Prowlarr Torznab',
            Accept: 'application/rss+xml,application/xml,text/xml,*/*',
          },
        });

        const items = parseRssItems(String(response.data || ''));
        logger.info(`Prowlarr returned ${items.length} RSS items for ${meta.imdbId} ("${query}")`);
        allItems.push(...items);
      } catch (err: any) {
        logger.warn('Prowlarr search failed for feed', {
          err: err?.message || String(err),
        });
      }
    }
  }

  const filtered = allItems
    .filter((item) => {
      const haystack = String(item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return !!titleNeedle && haystack.includes(titleNeedle);
    })
    .slice(0, maxResults);

  const mapped: TorrentResult[] = [];
  let hashLookups = 0;
  const seenHashes = new Set<string>();

  for (const item of filtered) {
    let infoHash =
      normalizeInfoHash(item.infoHash) ||
      normalizeInfoHash(item.magnetUrl) ||
      normalizeInfoHash(item.link) ||
      normalizeInfoHash(item.enclosureUrl) ||
      normalizeInfoHash(item.guid);

    const torrentUrl = item.enclosureUrl || item.link;

    if (!infoHash && torrentUrl && hashLookups < maxHashLookups) {
      hashLookups++;
      infoHash = await infoHashFromTorrentUrl(torrentUrl, timeout);
    }

    if (!infoHash) continue;

    const hash = infoHash.toLowerCase();
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);

    const { label } = parseQuality(item.title);

    mapped.push({
      title: item.title,
      infoHash: hash,
      magnetUrl: item.magnetUrl,
      size: item.size || 0,
      seeders: item.seeders || 0,
      quality: label,
      source: item.indexer ? `Prowlarr:${item.indexer}` : 'Prowlarr',
      hdr: parseHDR(item.title),
      dolbyVision: parseDolbyVision(item.title),
    });
  }

  mapped.sort((a, b) => {
    const qMap: Record<string, number> = { '4K': 5, '1080p': 4, '1080i': 3, '720p': 2, '480p': 1, SD: 0 };
    const rankA = qMap[a.quality] ?? -1;
    const rankB = qMap[b.quality] ?? -1;
    if (rankB !== rankA) return rankB - rankA;
    return b.seeders - a.seeders;
  });

  logger.info(`Prowlarr mapped ${mapped.length} filtered results for ${meta.imdbId}`, {
    rssItems: allItems.length,
    filtered: filtered.length,
    hashLookups,
  });

  return mapped;
}
