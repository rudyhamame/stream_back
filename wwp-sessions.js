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

// Records that `ownerId` is actively polling this session right now. Used by
// the streamer's start barrier as the reliable "both partners are here" signal
// (both clients poll wwp-sync; only the host reliably fetches the manifest).
// Returns how many distinct owners have checked in within the last 15s.
export function noteWwpPresence(wwpSessionId, ownerId) {
  const session = getWwpSession(wwpSessionId);
  if (!session || !ownerId) return 0;
  session.presence.set(String(ownerId), Date.now());
  const cutoff = Date.now() - 15_000;
  for (const [id, at] of session.presence) if (at < cutoff) session.presence.delete(id);
  return session.presence.size;
}

// Called on every manifest request that carries a wwpSessionId, whether or
// not the underlying job key actually changed - this both seeds a session on
// first contact and reconciles it on every subsequent seek/quality change,
// from either participant. A revision bump wakes up the OTHER participant's
// long-poll so their player follows to the new key.
export function reconcileWwpSession(wwpSessionId, { key, sourceId, kind, id, extension, start, quality, ownerId, userSeek }) {
  const sessionId = String(wwpSessionId || '');
  if (!sessionId) return null;
  let session = prune(sessions.get(sessionId));
  if (!session) {
    session = {
      key, sourceId, kind, id, extension, start, quality,
      revision: 1, controlRevision: 0, paused: false, controlPositionMs: 0, controlAt: 0,
      // Voice call: callRing is the ownerId of whoever tapped "Start call" (''
      // when nobody is ringing / a call is connected or ended). callSignals is
      // the WebRTC offer/answer/ICE relay between the two call pages.
      callRing: '', callRevision: 0, callSignals: [], callSeq: 0, callWaiters: new Set(),
      participantOwnerIds: new Set(), waiters: new Set(), updatedAt: Date.now(),
      createdAt: Date.now(), presence: new Map(), ended: false,
    };
    sessions.set(sessionId, session);
  }
  if (ownerId) session.participantOwnerIds.add(String(ownerId));
  // The WWP job key is session-only (start excluded), so a seek no longer
  // shows up as a key change. Move the partner ONLY on an explicit user seek
  // (wwpSeek flag) or an obviously-large jump (>30s) - never on the small
  // start drift that error-recovery / follow reloads carry, which otherwise
  // ping-pongs the two players whenever the provider is flaky.
  // hls.js keeps re-fetching the SAME manifest URL, so `wwpSeek=1` rides along
  // on every poll after one seek - only treat it as a seek when the position
  // has actually moved, else the partner gets yanked on every poll.
  const startDelta = Math.abs((Number(session.start) || 0) - (Number(start) || 0));
  const seeked = (Boolean(userSeek) && startDelta > 1) || startDelta > 30;
  const qualityChanged = Boolean(quality) && Boolean(session.quality) && quality !== session.quality;
  const changed = session.key !== key || seeked || qualityChanged;
  session.key = key;
  session.sourceId = sourceId;
  session.kind = kind;
  session.id = id;
  session.extension = extension;
  // Keep session.start pinned to the agreed position - only a real seek moves
  // it. Otherwise a recovery reload's drifted -ss would become the new anchor
  // and both players' displayed time would slowly wander.
  if (seeked || !session.start) session.start = start;
  session.quality = quality;
  session.updatedAt = Date.now();
  if (changed) {
    session.revision += 1;
    // A seek/quality restart also resumes playback on the acting side; clear a
    // stale paused flag so the follower does not immediately re-pause.
    session.paused = false;
    wakeWaiters(session);
  }
  return session;
}

// A single opaque token that changes whenever the underlying job (seek/
// quality), the play/pause control state, OR the voice-call ring state
// changes, so the one wwp-sync long-poll follows all three.
export function wwpSyncToken(session) {
  return session ? `${session.revision}.${session.controlRevision}.${session.callRevision}.${session.ended ? 1 : 0}` : '';
}

// Either participant closed their player -> tell the other to close too. Bumps
// the sync token (via the ended flag) so the partner's wwp-sync long-poll
// returns immediately with ended:true.
export function endWwpSession(wwpSessionId) {
  const session = prune(sessions.get(String(wwpSessionId || '')));
  if (!session || session.ended) return session || null;
  session.ended = true;
  session.updatedAt = Date.now();
  wakeWaiters(session);
  return session;
}

function wakeWaiters(session) {
  const waiters = session.waiters;
  session.waiters = new Set();
  const token = wwpSyncToken(session);
  for (const waiter of waiters) waiter(token);
}

// Play/pause (and the exact position it happened at) from either participant.
// This never restarts the shared ffmpeg job - the other player just matches
// playWhenReady, and realigns position only if it has drifted far.
export function applyWwpControl(wwpSessionId, { paused, positionMs }) {
  const session = prune(sessions.get(String(wwpSessionId || '')));
  if (!session) return null;
  session.paused = Boolean(paused);
  session.controlPositionMs = Math.max(0, Number(positionMs) || 0);
  session.controlAt = Date.now();
  session.controlRevision += 1;
  session.updatedAt = Date.now();
  wakeWaiters(session);
  return session;
}

// Voice call: someone tapped "Start call" (ringing=true) or the call ended /
// was declined (ringing=false). Bumps callRevision so the partner's wwp-sync
// long-poll returns and their UI shows the incoming-call prompt.
export function setWwpCallRing(wwpSessionId, ownerId, ringing) {
  const session = prune(sessions.get(String(wwpSessionId || '')));
  if (!session) return null;
  session.callRing = ringing ? String(ownerId || '') : '';
  session.callRevision += 1;
  session.updatedAt = Date.now();
  if (!ringing) { session.callSignals = []; session.callSeq = 0; }
  wakeWaiters(session);
  if (!ringing) wakeCallWaiters(session);
  return session;
}

function wakeCallWaiters(session) {
  const waiters = session.callWaiters;
  session.callWaiters = new Set();
  for (const waiter of waiters) waiter(session.callSeq);
}

// Relay one WebRTC signalling message (offer / answer / ice / bye) from one
// call page to the other. Kept in a bounded ring; 'bye' also ends the ring.
export function appendWwpCallSignal(wwpSessionId, fromOwnerId, kind, data) {
  const session = prune(sessions.get(String(wwpSessionId || '')));
  if (!session) return null;
  session.callSeq += 1;
  session.callSignals.push({ seq: session.callSeq, from: String(fromOwnerId || ''), kind: String(kind || ''), data });
  if (session.callSignals.length > 120) session.callSignals.splice(0, session.callSignals.length - 120);
  session.updatedAt = Date.now();
  if (kind === 'bye') { session.callRing = ''; session.callRevision += 1; wakeWaiters(session); }
  wakeCallWaiters(session);
  return session;
}

// Long-poll for call-signalling messages the caller has not seen yet and did
// not send themselves.
export function waitForWwpCallSignals(wwpSessionId, sinceSeq, selfOwnerId, timeoutMs = 20_000) {
  const sessionId = String(wwpSessionId || '');
  const session = prune(sessions.get(sessionId));
  if (!session) return Promise.resolve(null);
  const since = Number(sinceSeq) || 0;
  const pick = s => s.callSignals.filter(m => m.seq > since && m.from !== String(selfOwnerId || ''));
  if (pick(session).length > 0) return Promise.resolve({ seq: session.callSeq, signals: pick(session) });
  return new Promise(resolve => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      session.callWaiters.delete(finish);
      const live = prune(sessions.get(sessionId)) || session;
      resolve({ seq: live.callSeq, signals: pick(live) });
    };
    session.callWaiters.add(finish);
    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
}

export function waitForWwpSession(wwpSessionId, since, timeoutMs = 25_000) {
  const sessionId = String(wwpSessionId || '');
  const session = prune(sessions.get(sessionId));
  if (!session) return Promise.resolve(null);
  if (wwpSyncToken(session) !== String(since || '')) return Promise.resolve(session);
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
