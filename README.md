# Personal Stremio Addon

A personal Stremio-compatible addon for Nuvio with:
- **TorBox debrid** — instant streams for cached torrents
- **Jackett** — torrent search across all your indexers
- **HTTP fallback** — VidSrc / VixSrc serve immediately on first request
- **Redis caching** — stale-while-revalidate for sub-50ms repeat loads
- **Auto-cache** — uncached torrents are automatically sent to TorBox
- **Pre-cache worker** — trending titles warmed every 6 hours

---

## How it works

```
Request comes in
    ↓
Redis cache hit (fresh)?  → return in < 50ms ✅
    ↓ miss or stale
Serve HTTP fallback immediately (fast)
    + trigger background job:
        Jackett search → TorBox availability check → cache result
    ↓
Next request → full debrid streams, instant ✅
```

---

## Setup

### 1. Prerequisites

- Docker + Docker Compose on your Oracle server
- Jackett running (self-hosted)
- TorBox account with API key
- TMDB API key (free at themoviedb.org/settings/api)
- NGINX / NPM pointing to your server

### 2. Clone and configure

```bash
git clone <your-repo> stremio-addon
cd stremio-addon

cp .env.example .env
nano .env   # Fill in your keys
```

**Minimum required `.env` values:**
```
TORBOX_API_KEY=...
JACKETT_URL=http://your-jackett-ip:9117
JACKETT_API_KEY=...
TMDB_API_KEY=...
```

### 3. Deploy

```bash
cd docker
docker compose up -d --build
```

Check it's running:
```bash
curl http://localhost:7000/health
curl http://localhost:7000/manifest.json
```

### 4. NGINX / NPM

If using **Nginx Proxy Manager**:
1. Add a new Proxy Host
2. Domain: `addon.yourdomain.com`
3. Forward to: `127.0.0.1:7000`
4. Enable SSL with Let's Encrypt
5. Under "Advanced", paste the CORS headers from `nginx/stremio-addon.conf`

If using **bare NGINX**, copy `nginx/stremio-addon.conf` to `/etc/nginx/sites-available/` and symlink it.

### 5. Install in Nuvio

1. Open Nuvio → Settings → Addons
2. Paste: `https://addon.yourdomain.com/manifest.json`
3. Done — streams will appear under any movie or show

---

## Adding more providers

Add a new file to `src/http-fallback/` or `src/providers/` following this pattern:

```typescript
// src/http-fallback/myprovider.ts
import { HttpStream } from '../types';

export async function getMyProviderStreams(
  imdbId: string,
  season?: number,
  episode?: number
): Promise<HttpStream[]> {
  // fetch and return streams
}
```

Then import and call it in `src/http-fallback/index.ts`.

---

## Cache management

Clear all stream cache:
```bash
docker exec stremio-redis redis-cli KEYS "streams:*" | xargs docker exec stremio-redis redis-cli DEL
```

Clear a specific title:
```bash
docker exec stremio-redis redis-cli DEL "streams:tt1375666"
```

View cache stats:
```bash
docker exec stremio-redis redis-cli INFO stats
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7000` | HTTP server port |
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL |
| `TORBOX_API_KEY` | — | **Required** TorBox API key |
| `TORBOX_AUTO_CACHE` | `true` | Auto-send uncached torrents to TorBox |
| `JACKETT_URL` | — | **Required** Jackett base URL |
| `JACKETT_API_KEY` | — | **Required** Jackett API key |
| `JACKETT_INDEXERS` | `all` | Comma-separated indexer IDs, or `all` |
| `JACKETT_TIMEOUT` | `8000` | Jackett request timeout (ms) |
| `TMDB_API_KEY` | — | TMDB key for pre-cache worker |
| `ENABLE_VIDSRC` | `true` | Enable VidSrc HTTP fallback |
| `ENABLE_VIXSRC` | `true` | Enable VixSrc HTTP fallback |
| `ENABLE_SHOWBOX` | `false` | Enable ShowBox (needs FebBox cookie) |
| `CACHE_TTL_STREAMS` | `1800` | Soft cache TTL for stream results (seconds) |
| `CACHE_TTL_DEBRID` | `86400` | Cache TTL for TorBox availability (seconds) |
| `PRECACHE_ENABLED` | `true` | Enable background pre-cache worker |
| `PRECACHE_CRON` | `0 */6 * * *` | Pre-cache schedule (cron format) |
| `PRECACHE_LIMIT` | `50` | Max titles to pre-cache per run |
