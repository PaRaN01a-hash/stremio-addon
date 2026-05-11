// src/server.ts
import express, { Request, Response } from 'express';
import { manifest, streamHandler } from './addon';
import { logger } from './utils/logger';

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

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: manifest.version, name: manifest.name });
  });

  // Root — redirect to manifest for convenience
  app.get('/', (_req: Request, res: Response) => {
    res.redirect('/manifest.json');
  });

  return app;
}
