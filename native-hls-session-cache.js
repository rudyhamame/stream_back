import { hlsSessionKey } from './media-session-policy.js';

// Native provider HLS sessions own short-lived manifest, segment, and bitrate
// state. Keep their lifetime and account boundary in one place.
export function createNativeHlsSessionCache({ ttlMs = 60_000, maxEntries = 16 } = {}) {
  const sessions = new Map();

  function evict(now = Date.now()) {
    for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
    while (sessions.size > maxEntries) sessions.delete(sessions.keys().next().value);
  }

  function get(req, identity, create = false) {
    evict();
    const key = hlsSessionKey(req.params.sourceId, 'channel', req.params.id, req.query.ext, 0);
    let session = sessions.get(key);
    if (session && session.userId && session.userId !== identity.userId) session = null;
    if (!session && create) {
      session = {
        key,
        userId: identity.userId,
        viewerId: identity.viewerId,
        viewers: new Set([identity.viewerId]),
        resources: new Map(),
        manifests: new Map(),
        resourceBodies: new Map(),
        segmentMetadata: new Map(),
        bitrateSamples: new Map(),
        timelineSequences: new Map(),
        nextTimelineSequence: 0,
        cacheBust: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        expiresAt: Date.now() + ttlMs,
      };
      sessions.set(key, session);
      evict();
    }
    if (session) {
      if (identity.viewerId) session.viewers?.add(identity.viewerId);
      session.expiresAt = Date.now() + ttlMs;
      sessions.delete(key);
      sessions.set(key, session);
    }
    return session;
  }

  return { sessions, get, evict };
}
