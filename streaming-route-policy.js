const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const EXACT_STREAMING_PATHS = new Set([
  '/api/health',
  '/api/live',
  '/api/roku/auth-health',
  '/api/roku/internet-health',
  '/api/playback/preview',
  '/internal/media-health',
  '/internal/active-streams',
]);

const STREAMING_PATH_PATTERNS = [
  // Loopback-only: library_backend asks for a VOD runtime this streamer learned
  // while serving the title (auth'd by loopbackRequest inside the route).
  /^\/internal\/media-duration\/[^/]+\/(?:movie|series)\/[^/]+$/,
  /^\/api\/roku\/playback-decision\/[^/]+\/(?:movie|series)\/[^/]+$/,
  /^\/api\/xtream\/play\/[^/]+\/(?:channel|movie|series)\/[^/]+$/,
  /^\/api\/xtream\/hls\/[^/]+\/(?:channel|movie|series)\/[^/]+\/master\.m3u8$/,
  /^\/api\/xtream\/hls\/[^/]+\/(?:channel|movie|series)\/[^/]+\/segment-\d{6}\.ts$/,
  /^\/api\/xtream\/hls\/[^/]+\/channel\/[^/]+\/resource\/[a-f0-9]{24}$/,
  // Watch with Partner: long-poll for the other participant's seek/quality
  // change. Read-only, scoped to one session id, authorized inside the route
  // itself (device session or stream ticket) - no account/library surface.
  /^\/api\/xtream\/wwp-sync\/[^/]+$/,
  // Watch with Partner: relay this participant's play/pause to the other one.
  // A GET (state in the query) so it passes the read-only streaming policy;
  // authorized inside the route by the same device session / stream ticket.
  /^\/api\/xtream\/wwp-control\/[^/]+$/,
  // Watch with Partner: one participant closed their player; end the session so
  // the other closes too. GET here; also POST (sendBeacon) via the write list.
  /^\/api\/xtream\/wwp-end\/[^/]+$/,
  // Watch with Partner voice call: ring state, signalling long-poll, and the
  // self-contained call page. Same per-session auth as wwp-sync.
  /^\/api\/xtream\/wwp-call\/[^/]+\/(?:ring|poll|page)$/,
];

// Paths that also accept POST from the streaming origin - only the WebRTC
// signalling relay, whose payload (an SDP blob) is too large for a query
// string. Session-scoped and auth'd inside the route, same as the rest.
const WRITE_STREAMING_PATTERNS = [
  /^\/api\/xtream\/wwp-call\/[^/]+\/signal$/,
  /^\/api\/xtream\/wwp-end\/[^/]+$/,
  // Account handoff coordinator: loopback-only and limited by the route to
  // Android jobs for one provider source.
  /^\/internal\/streams\/android-handoff$/,
  // "Play on Roku" hand-off: the phone tells the streamer to drop its own
  // ffmpeg job + provider lease immediately so the Roku can take the slot.
  // Scoped to the caller's own playback viewer identity inside the route.
  /^\/api\/xtream\/playback\/release$/,
];

export function isStreamingRoute(method, pathname) {
  const upper = String(method || '').toUpperCase();
  const path = String(pathname || '').split('?')[0];
  if (upper === 'POST') return WRITE_STREAMING_PATTERNS.some(pattern => pattern.test(path));
  if (!READ_METHODS.has(upper)) return false;
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
