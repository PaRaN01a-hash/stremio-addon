// src/index.ts
import 'dotenv/config';
import { createServer } from './server';
import { getRedis } from './cache/redis';
import { startPrecacheWorker } from './workers/precache';
import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT || '7000');

async function main() {
  // Warm up Redis connection
  try {
    await getRedis().connect();
    logger.info('Redis ready');
  } catch (err: any) {
    logger.warn('Redis connect failed — caching disabled', { err: err.message });
  }

  const app = createServer();

  app.listen(PORT, () => {
    logger.info(`Addon running on port ${PORT}`);
    logger.info(`Manifest: http://localhost:${PORT}/manifest.json`);
  });

  // Start background pre-cache worker
  startPrecacheWorker();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down');
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal startup error', { err: err.message });
  process.exit(1);
});
