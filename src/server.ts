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
