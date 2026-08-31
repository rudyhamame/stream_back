const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const EXACT_STREAMING_PATHS = new Set([
  '/api/health',
  '/api/live',
  '/api/roku/auth-health',
  '/api/playback/preview',
  '/internal/media-health',
]);

const STREAMING_PATH_PATTERNS = [
  /^\/api\/xtream\/play\/[^/]+\/(?:channel|movie|series)\/[^/]+$/,
  /^\/api\/xtream\/hls\/[^/]+\/(?:channel|movie|series)\/[^/]+\/master\.m3u8$/,
  /^\/api\/xtream\/hls\/[^/]+\/(?:channel|movie|series)\/[^/]+\/segment-\d{6}\.ts$/,
  /^\/api\/xtream\/hls\/[^/]+\/channel\/[^/]+\/resource\/[a-f0-9]{24}$/,
  /^\/api\/trickplay\/[^/]+\/(?:movie|episode)\/[^/]+\/preview\.bif$/,
];

export function isStreamingRoute(method, pathname) {
  if (!READ_METHODS.has(String(method || '').toUpperCase())) return false;
  const path = String(pathname || '').split('?')[0];
  return EXACT_STREAMING_PATHS.has(path) || STREAMING_PATH_PATTERNS.some(pattern => pattern.test(path));
}

export function enforceStreamingOnly(req, res, next) {
  if (isStreamingRoute(req.method, req.path)) {
    res.setHeader('X-Backend-Role', 'streaming');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
    return;
  }
  // A deny-by-default 404 avoids advertising account, library, catalog, or
  // device-management capabilities from the public streaming origin.
  res.status(404).json({ error: 'Not found' });
}

export const streamingRoutePolicy = Object.freeze({
  methods: Object.freeze([...READ_METHODS]),
  exactPaths: Object.freeze([...EXACT_STREAMING_PATHS]),
  patterns: Object.freeze(STREAMING_PATH_PATTERNS.map(pattern => pattern.source)),
});
