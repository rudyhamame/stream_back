// Watch with Partner: two accounts sharing one ffmpeg job/provider connection.
// This is in-memory and process-local by design - Browser and Android always
// hit this one streamer process (port 8788; Roku's 8789 process never
// participates in WWP), so a session never needs to be visible across
// processes. Keyed by wwpSessionId (an unguessable token handed to both the
// host and the invited partner by library_backend's /api/partner/invite).
const sessions = new Map();
const sessionTtlMs = 12 * 60 * 60 * 1000;

function prune(session) {
  return session && Date.now() - session.updatedAt < sessionTtlMs ? session : null;
}

export function getWwpSession(wwpSessionId) {
  return prune(sessions.get(String(wwpSessionId || '')));
}

// Called on every manifest request that carries a wwpSessionId, whether or
// not the underlying job key actually changed - this both seeds a session on
// first contact and reconciles it on every subsequent seek/quality change,
// from either participant. A revision bump wakes up the OTHER participant's
// long-poll so their player follows to the new key.
export function reconcileWwpSession(wwpSessionId, { key, sourceId, kind, id, extension, start, quality, ownerId }) {
  const sessionId = String(wwpSessionId || '');
  if (!sessionId) return null;
  let session = prune(sessions.get(sessionId));
  if (!session) {
    session = { key, sourceId, kind, id, extension, start, quality, revision: 1, participantOwnerIds: new Set(), waiters: new Set(), updatedAt: Date.now() };
    sessions.set(sessionId, session);
  }
  if (ownerId) session.participantOwnerIds.add(String(ownerId));
  const changed = session.key !== key;
  session.key = key;
  session.sourceId = sourceId;
  session.kind = kind;
  session.id = id;
  session.extension = extension;
  session.start = start;
  session.quality = quality;
  session.updatedAt = Date.now();
  if (changed) {
    const revision = session.revision + 1;
    session.revision = revision;
    const waiters = session.waiters;
    session.waiters = new Set();
    for (const waiter of waiters) waiter(revision);
  }
  return session;
}

export function waitForWwpSession(wwpSessionId, since, timeoutMs = 25_000) {
  const sessionId = String(wwpSessionId || '');
  const session = prune(sessions.get(sessionId));
  if (!session) return Promise.resolve(null);
  if (session.revision !== since) return Promise.resolve(session);
  return new Promise(resolve => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      session.waiters.delete(finish);
      resolve(prune(sessions.get(sessionId)) || session);
    };
    session.waiters.add(finish);
    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
}
