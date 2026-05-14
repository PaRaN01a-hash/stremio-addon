function envBool(name: string, defaultValue: boolean): boolean {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw);
}

function envNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function listCount(value: string | undefined): number {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .length;
}

function hasValue(name: string): boolean {
  return Boolean(String(process.env[name] || '').trim());
}

function providerLast(): Record<string, any> {
  return ((globalThis as any).streamStats?.providerLast || {}) as Record<string, any>;
}

export function getSourceRegistry(): Record<string, any> {
  const last = providerLast();

  const externalStreamAddonCount = listCount(process.env.EXTERNAL_STREAM_ADDONS);
  const streamthruManifestCount = listCount(process.env.STREAMTHRU_MANIFEST_URLS);
  const prowlarrTorznabCount = listCount(process.env.PROWLARR_TORZNAB_URLS);
  const externalStremioAddonCount = listCount(process.env.EXTERNAL_STREMIO_ADDONS);

  return {
    status: 'ok',
    generatedAt: new Date().toISOString(),

    engine: {
      localIndexFirst: envBool('LOCAL_INDEX_FIRST', true),
      coreSortStreams: envBool('CORE_SORT_STREAMS', false),
      externalAddonsOnColdLoad: envBool('EXTERNAL_ADDONS_ON_COLD_LOAD', true),
      torboxMaxSizeGB: process.env.TORBOX_MAX_SIZE_GB || process.env.MAX_SIZE_GB || 'unknown',
      maxFinalStreams: process.env.MAX_FINAL_STREAMS || '40',
    },

    sources: [
      {
        id: 'local-index',
        name: 'Maximus Local Index Memory',
        kind: 'memory',
        wired: true,
        enabled: envBool('LOCAL_INDEX_FIRST', true),
        priority: 0,
        role: 'Serve known-good streams instantly before provider fetch',
        last: {
          finalStreamCount: last.finalStreamCount,
          totalMs: last.totalMs,
          coreSort: last.coreSort,
        },
      },
      {
        id: 'zilean',
        name: 'Zilean DMM',
        kind: 'torrent-index',
        wired: true,
        enabled: true,
        configured: hasValue('ZILEAN_URL') || true,
        apiKeyConfigured: hasValue('ZILEAN_API_KEY'),
        priority: 10,
        timeoutMs: 'provider default',
        maxResults: envNumber('ZILEAN_MAX_RESULTS', 60),
        role: 'Fast hash/title discovery',
        last: {
          count: last.zileanCount,
          useful: last.quality?.signals?.zileanUseful,
          ms: (globalThis as any).streamStats?.zileanMs,
        },
      },
      {
        id: 'torbox',
        name: 'TorBox',
        kind: 'debrid-resolver',
        wired: true,
        enabled: hasValue('TORBOX_API_KEY'),
        apiKeyConfigured: hasValue('TORBOX_API_KEY'),
        priority: 20,
        maxSizeGB: process.env.TORBOX_MAX_SIZE_GB || '25',
        autoCache: envBool('TORBOX_AUTO_CACHE', false),
        role: 'Check cached hashes and produce Maximus resolver URLs',
        last: {
          candidateTorrents: last.torboxCandidateTorrents,
          cached: last.torboxCached,
          cacheRate: last.quality?.torboxCacheRate,
          grade: last.quality?.torboxGrade,
          ms: last.torboxMs,
        },
      },
      {
        id: 'jackett',
        name: 'Jackett',
        kind: 'torznab',
        wired: true,
        enabled: hasValue('JACKETT_URL') && hasValue('JACKETT_API_KEY'),
        urlConfigured: hasValue('JACKETT_URL'),
        apiKeyConfigured: hasValue('JACKETT_API_KEY'),
        priority: 30,
        maxResults: envNumber('JACKETT_MAX_RESULTS', 20),
        fallbackThreshold: envNumber('ZILEAN_MIN_RESULTS_BEFORE_JACKETT', 10),
        role: 'Fallback torrent discovery when Zilean is thin',
        last: {
          used: last.jackettDecision?.used,
          reason: last.jackettDecision?.reason,
          count: last.jackettCount,
          noiseLevel: last.quality?.jackettNoiseLevel,
          titleGuardRejected: last.titleGuardRejected,
          titleGuardRejectRate: last.quality?.titleGuardRejectRate,
        },
      },
      {
        id: 'http-fallback',
        name: 'HTTP Fallback',
        kind: 'direct-http',
        wired: true,
        enabled: true,
        priority: 40,
        role: 'Fallback direct HTTP stream provider if configured internally',
        last: {
          count: last.httpStreamCount,
        },
      },
      {
        id: 'prowlarr',
        name: 'Prowlarr Torznab',
        kind: 'torznab',
        wired: true,
        enabled: prowlarrTorznabCount > 0,
        configuredCount: prowlarrTorznabCount,
        coldLoadEnabled: envBool('PROWLARR_ON_COLD_LOAD', false),
        priority: 35,
        maxResults: envNumber('PROWLARR_MAX_RESULTS', 40),
        role: 'Self-hosted Torznab torrent discovery lane, feeding TorBox and Maximus memory',
        last: {
          count: last.prowlarrCount || 0,
          decision: last.prowlarrDecision || {},
          useful: last.quality?.signals?.prowlarrUseful,
        },
      },
      {
        id: 'streamthru',
        name: 'Self-hosted StremThru',
        kind: 'stremio-addon-bridge',
        wired: true,
        enabled: streamthruManifestCount > 0,
        configuredCount: streamthruManifestCount,
        coldLoadEnabled: envBool('EXTERNAL_ADDONS_ON_COLD_LOAD', true),
        priority: 45,
        maxStreams: envNumber('MAX_EXTERNAL_STREAMS', 4),
        role: 'Use configured self-hosted StremThru manifest URLs as source feeders, then Maximus scores and remembers accepted hashes',
        last: {
          externalAddonCount: last.externalAddonCount,
          contributed: last.quality?.signals?.externalContributed,
        },
      },
      {
        id: 'external-stream-addons',
        name: 'External Stream Addons',
        kind: 'stremio-addon-bridge',
        wired: true,
        enabled: externalStreamAddonCount > 0,
        configuredCount: externalStreamAddonCount,
        coldLoadEnabled: envBool('EXTERNAL_ADDONS_ON_COLD_LOAD', true),
        priority: 50,
        maxStreams: envNumber('MAX_EXTERNAL_STREAMS', 4),
        role: 'Ask configured external addons, then Maximus scores and remembers accepted hashes',
        last: {
          count: last.externalAddonCount,
          contributed: last.quality?.signals?.externalContributed,
        },
      },
      {
        id: 'external-stremio',
        name: 'External Stremio Addons',
        kind: 'legacy-stremio-bridge',
        wired: true,
        enabled: externalStremioAddonCount > 0,
        configuredCount: externalStremioAddonCount,
        timeoutMs: envNumber('EXTERNAL_STREMIO_TIMEOUT', 8000),
        priority: 60,
        role: 'Legacy external Stremio stream bridge',
        last: {
          count: last.externalStremioCount,
        },
      },
    ],

    lastProviderRun: last,
  };
}
