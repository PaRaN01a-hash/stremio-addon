// src/server.ts
import express, { Request, Response } from 'express';

(globalThis as any).streamStats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  zileanMs: 0,
  torboxMs: 0,
  externalMs: 0,
  lastRequest: null,
};
import { manifest, streamHandler } from './addon';
import { logger } from './utils/logger';
import { getDebridStreamUrlByHash } from './torbox';
import { getStreams, localIndexFirstEnabled, coreSortStreamsEnabled, externalAddonsOnColdLoadEnabled } from './providers/streams';
import { scoreStreamCandidate } from './core/candidate-match';
import { candidateSortScore, bucketCandidate, sortCandidates } from './core/candidate-sort';
import { clearKnownGoodStreams, getKnownGoodStreams, localIndexKey, saveManualKnownGoodStreams } from './core/local-index';

export function createServer(): express.Application {
  const app = express();

  app.use(express.json());

  // CORS — required for Stremio/Nuvio
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    next();
  });

  // Request logging
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
  });

  // ── Stremio Addon Protocol endpoints ──────────────────────────────────────

  // Manifest
  app.get('/manifest.json', (_req: Request, res: Response) => {
    res.json(manifest);
  });

  // Stream handler
  app.get('/stream/:type/:id.json', async (req: Request, res: Response) => {
    const { type, id } = req.params;
    try {
      const result = await streamHandler(type, decodeURIComponent(id));
      res.json(result);
    } catch (err: any) {
      logger.error('Stream handler error', { type, id, err: err.message });
      res.status(500).json({ streams: [] });
    }
  });


  // Lazy TorBox resolver: only asks TorBox for a playable URL when the user presses play.
  app.get('/resolve', async (req: Request, res: Response) => {
    try {
      const hash = String(req.query.hash || '').trim().toLowerCase();
      const season = req.query.season !== undefined ? Number(req.query.season) : undefined;
      const episode = req.query.episode !== undefined ? Number(req.query.episode) : undefined;

      if (!/^[a-f0-9]{40}$/.test(hash)) {
        return res.status(400).send('Invalid hash');
      }

      const freshUrl = await getDebridStreamUrlByHash(hash, season, episode);

      if (!freshUrl) {
        return res.status(404).send('Could not resolve stream');
      }

      return res.redirect(302, freshUrl);
    } catch (err: any) {
      logger.error('Lazy resolve failed', { err: err.message });
      return res.status(500).send('Resolve failed');
    }
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: manifest.version, name: manifest.name });
  });


  // Lightweight stats endpoint
  app.get('/debug/streams/:type/:id.json', async (req: Request, res: Response) => {
    try {
      const type = req.params.type as 'movie' | 'series';
      const rawId = req.params.id;

      const parts = rawId.split(':');
      const imdbId = parts[0];
      const season = parts[1] ? parseInt(parts[1], 10) : undefined;
      const episode = parts[2] ? parseInt(parts[2], 10) : undefined;

      const expectedTitle = String(
        req.query.title ||
        req.query.name ||
        ''
      ).trim();

      const debugSort = String(req.query.sort || '').toLowerCase();

      const started = Date.now();

      const streams = await getStreams({
        id: rawId,
        imdbId,
        type,
        season,
        episode,
          title: expectedTitle || undefined,
      });

      res.json({
        status: 'ok',
        tookMs: Date.now() - started,
          request: { type, id: rawId, imdbId, season, episode, expectedTitle, debugSort },
        count: streams.length,
          streams: (debugSort === 'core'
            ? sortCandidates(streams.map((stream: any, index: number) => scoreStreamCandidate({
                id: String(stream.url || stream.behaviorHints?.filename || stream.title || stream.name || index),
                provider: stream.name?.startsWith('[TB+]') ? 'torbox' : 'external-addon',
                sourceType: stream.name?.startsWith('[TB+]') ? 'cached' : 'external',
                name: stream.name,
                title: stream.title,
                filename: stream.behaviorHints?.filename,
                description: stream.description,
                url: stream.url,
                size: stream.behaviorHints?.videoSize,
                raw: stream,
              }, {
                type,
                title: expectedTitle,
                season,
                episode,
              })))
            : streams.map((stream: any, index: number) => scoreStreamCandidate({
                id: String(stream.url || stream.behaviorHints?.filename || stream.title || stream.name || index),
                provider: stream.name?.startsWith('[TB+]') ? 'torbox' : 'external-addon',
                sourceType: stream.name?.startsWith('[TB+]') ? 'cached' : 'external',
                name: stream.name,
                title: stream.title,
                filename: stream.behaviorHints?.filename,
                description: stream.description,
                url: stream.url,
                size: stream.behaviorHints?.videoSize,
                raw: stream,
              }, {
                type,
                title: expectedTitle,
                season,
                episode,
              }))
          ).map((scoredCandidate: any, index: number) => {
            const stream = scoredCandidate.raw || {};
            const parsedRelease = scoredCandidate.parsedRelease || {
              raw: '',
              cleaned: '',
              normalizedTitle: '',
              type: 'unknown',
              quality: 'unknown',
              isPack: false,
              isSeasonPack: false,
              isEpisodePack: false,
              flags: [],
              tokens: [],
            };
            const match = scoredCandidate.match;

            return {
              index: index + 1,
              name: stream.name,
              title: stream.title,
              description: stream.description,
              urlHost: (() => {
                try { return new URL(stream.url).host; } catch { return null; }
              })(),
              bingeGroup: stream.behaviorHints?.bingeGroup,
              filename: stream.behaviorHints?.filename,
              videoSize: stream.behaviorHints?.videoSize,
              matchSource: scoredCandidate.matchSource,
              parseable: scoredCandidate.parseable,
              releaseTitle: scoredCandidate.filename || scoredCandidate.title || scoredCandidate.name || '',
              bucket: bucketCandidate(scoredCandidate),
              sortScore: candidateSortScore(scoredCandidate),
              parsedRelease: {
                normalizedTitle: parsedRelease.normalizedTitle,
                type: parsedRelease.type,
                year: parsedRelease.year,
                season: parsedRelease.season,
                episode: parsedRelease.episode,
                episodeEnd: parsedRelease.episodeEnd,
                quality: parsedRelease.quality,
                source: parsedRelease.source,
                isSeasonPack: parsedRelease.isSeasonPack,
              },
              match,
            };
          }),
      });
    } catch (err: any) {
      res.status(500).json({
        status: 'error',
        error: err.message || 'debug_streams_failed',
      });
    }
  });

  app.get('/debug/local-index/:type/:id.json', async (req: Request, res: Response) => {
    try {
      const type = req.params.type as 'movie' | 'series';
      const rawId = req.params.id;

      const parts = rawId.split(':');
      const imdbId = parts[0];
      const season = parts[1] ? parseInt(parts[1], 10) : undefined;
      const episode = parts[2] ? parseInt(parts[2], 10) : undefined;

      const meta = {
        id: rawId,
        imdbId,
        type,
        season,
        episode,
      };

      const indexed = await getKnownGoodStreams(meta);

      res.json({
        status: 'ok',
        request: { type, id: rawId, imdbId, season, episode },
        key: localIndexKey(meta),
        count: indexed.length,
        streams: indexed.map((item, index) => ({
          index: index + 1,
          id: item.id,
          name: item.name,
          title: item.title,
          filename: item.filename,
          url: item.url,
          size: item.size,
          bucket: item.bucket,
          sortScore: item.sortScore,
          matchDecision: item.matchDecision,
          matchScore: item.matchScore,
          indexedAt: item.indexedAt,
        })),
      });
    } catch (err: any) {
      res.status(500).json({
        status: 'error',
        error: err.message || 'debug_local_index_failed',
      });
    }
  });

  app.delete('/debug/local-index/:type/:id.json', async (req: Request, res: Response) => {
    try {
      const requiredToken = String(process.env.LOCAL_INDEX_ADMIN_TOKEN || '').trim();

      if (requiredToken) {
        const suppliedToken = String(
          req.query.token ||
          req.header('x-local-index-token') ||
          ''
        ).trim();

        if (suppliedToken !== requiredToken) {
          return res.status(403).json({
            status: 'error',
            error: 'local_index_admin_token_required',
          });
        }
      }

      const type = req.params.type as 'movie' | 'series';
      const rawId = req.params.id;

      const parts = rawId.split(':');
      const imdbId = parts[0];
      const season = parts[1] ? parseInt(parts[1], 10) : undefined;
      const episode = parts[2] ? parseInt(parts[2], 10) : undefined;

      const meta = {
        id: rawId,
        imdbId,
        type,
        season,
        episode,
      };

      await clearKnownGoodStreams(meta);

      res.json({
        status: 'ok',
        action: 'deleted',
        request: { type, id: rawId, imdbId, season, episode },
        key: localIndexKey(meta),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        error: err.message || 'clear_local_index_failed',
      });
    }
  });

  app.post('/debug/local-index/:type/:id.json', async (req: Request, res: Response) => {
    try {
      const requiredToken = String(process.env.LOCAL_INDEX_ADMIN_TOKEN || '').trim();

      if (requiredToken) {
        const suppliedToken = String(
          req.query.token ||
          req.header('x-local-index-token') ||
          ''
        ).trim();

        if (suppliedToken !== requiredToken) {
          return res.status(403).json({
            status: 'error',
            error: 'local_index_admin_token_required',
          });
        }
      }

      const type = req.params.type as 'movie' | 'series';
      const rawId = req.params.id;

      const parts = rawId.split(':');
      const imdbId = parts[0];
      const season = parts[1] ? parseInt(parts[1], 10) : undefined;
      const episode = parts[2] ? parseInt(parts[2], 10) : undefined;

      const title = String(req.body?.title || req.body?.name || '').trim();
      const streams = Array.isArray(req.body?.streams) ? req.body.streams : [];

      const meta = {
        id: rawId,
        imdbId,
        type,
        season,
        episode,
      };

      const indexed = await saveManualKnownGoodStreams(meta, streams, title);

      res.json({
        status: 'ok',
        request: { type, id: rawId, imdbId, season, episode, title },
        key: localIndexKey(meta),
        count: indexed.length,
        streams: indexed.map((item, index) => ({
          index: index + 1,
          id: item.id,
          name: item.name,
          title: item.title,
          filename: item.filename,
          url: item.url,
          size: item.size,
          bucket: item.bucket,
          sortScore: item.sortScore,
          matchDecision: item.matchDecision,
          matchScore: item.matchScore,
          indexedAt: item.indexedAt,
        })),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        error: err.message || 'manual_local_index_failed',
      });
    }
  });

  app.get('/debug/engine', async (_req: Request, res: Response) => {
    const stats = (globalThis as any).streamStats || {};

    res.json({
      status: 'ok',
      service: 'maximus-core-engine',
      timestamp: new Date().toISOString(),
      flags: {
        localIndexFirst: localIndexFirstEnabled(),
        coreSortStreams: coreSortStreamsEnabled(),
        externalAddonsOnColdLoad: externalAddonsOnColdLoadEnabled(),
      },
      env: {
        publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.BASE_URL || null,
        localIndexTtl: process.env.LOCAL_INDEX_TTL || String(60 * 60 * 24 * 30),
        streamSoftTtl: process.env.STREAM_SOFT_TTL || null,
        streamHardTtl: process.env.STREAM_HARD_TTL || null,
        localIndexAdminTokenConfigured: Boolean(String(process.env.LOCAL_INDEX_ADMIN_TOKEN || '').trim()),
      },
      stats: {
        requests: stats.requests || 0,
        cacheHits: stats.cacheHits || 0,
        cacheMisses: stats.cacheMisses || 0,
        lastRequest: stats.lastRequest || null,
        externalRefreshes: stats.externalRefreshes || 0,
        externalLastCount: stats.externalLastCount || 0,
        torboxMs: stats.torboxMs || null,
      },
      providerLast: stats.providerLast || null,
    });
  });

  app.get('/stats', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      timestamp: new Date().toISOString(),
      env: {
        maxFinalStreams: process.env.MAX_FINAL_STREAMS || process.env.FINAL_STREAMS || 'unknown',
        torboxMaxSizeGB: process.env.TORBOX_MAX_SIZE_GB || 'unknown',
        zileanMaxResults: process.env.ZILEAN_MAX_RESULTS || 'unknown',
        resolveCacheTTL: process.env.CACHE_TTL_RESOLVE || 'unknown',
      },
      runtime: (globalThis as any).streamStats || {},
    });
  });

  // Root — redirect to manifest for convenience
  app.get('/', (_req: Request, res: Response) => {
    res.redirect('/manifest.json');
  });

  return app;
}
