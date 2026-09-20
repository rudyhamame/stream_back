import { createHash } from 'node:crypto';

export function hlsSessionKey(sourceId, kind, id, extension, startSeconds = 0, capabilityKey = '') {
  const normalizedExtension = String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return createHash('sha256')
    .update(`${sourceId}:${kind}:${id}:${normalizedExtension}:${startSeconds}:${String(capabilityKey)}`)
    .digest('hex')
    .slice(0, 24);
}

export function hlsChildRequestQuery(query = {}, startSeconds = 0) {
  const params = new URLSearchParams();
  const deviceToken = String(query.deviceToken || '').trim();
  if (deviceToken) params.set('deviceToken', deviceToken);
  const streamTicket = String(query.streamTicket || '').trim();
  if (streamTicket) params.set('streamTicket', streamTicket);
  const extension = String(query.ext || '').trim();
  if (extension) params.set('ext', extension);
  const client = String(query.client || '').trim();
  if (client) params.set('client', client);
  const capabilities = String(query.caps || '').trim();
  if (capabilities) params.set('caps', capabilities);
  const quality = String(query.quality || '').trim();
  if (quality) params.set('quality', quality);
  // Recovery manifests run in a distinct ffmpeg job. Relative segment URLs
  // must retain that job identity or the segment route looks up the normal
  // stream and returns 404 for every recovery segment.
  const hlsFallback = String(query.hlsFallback || '').trim().toLowerCase();
  if (['remux', 'audio', 'video', 'partial', 'full'].includes(hlsFallback)) params.set('hlsFallback', hlsFallback);
  const playbackAttemptId = String(query.playbackAttemptId || '').trim();
  if (/^\d{1,9}$/.test(playbackAttemptId)) params.set('playbackAttemptId', playbackAttemptId);
  const sessionId = String(query.sessionId || '').trim();
  if (/^[a-z0-9._:-]{1,160}$/i.test(sessionId)) params.set('sessionId', sessionId);
  // Keep each Android install in its own playback-control lane. Account
  // tokens do not contain a linked-device id, so without this value Android
  // falls back to the account owner and can collide with another player.
  const playbackClientId = String(query.playbackClientId || '').trim();
  if (playbackClientId) params.set('playbackClientId', playbackClientId);
  // Watch with Partner: the segment requests must resolve to the one shared
  // job key too, so carry the session id onto every child request.
  const wwpSessionId = String(query.wwpSessionId || '').trim();
  if (wwpSessionId) params.set('wwpSessionId', wwpSessionId);
  if (startSeconds > 0) params.set('start', String(startSeconds));
  return params;
}

export function scopedPlaybackViewerId(baseViewerId, client, playbackClientId) {
  const base = String(baseViewerId || 'anonymous');
  const kind = String(client || '').trim().toLowerCase();
  const id = String(playbackClientId || '').trim();
  if (!['android', 'browser'].includes(kind) || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(id)) return base;
  return `${base}:${kind}:${id}`;
}

export function samePlaybackViewer(job, identity) {
  if (!job || !identity) return false;
  if (identity.deviceId) return job.deviceId === identity.deviceId;
  if (!identity.viewerId) return false;
  return job.viewerId === identity.viewerId || job.viewers?.has(identity.viewerId) === true;
}

export function isPlaybackSupersededForViewer(job, identity, nextKey = '') {
  if (!job?.persistent || job.key === nextKey) return false;
  return samePlaybackViewer(job, identity);
}

export function isSnapshotSupersededForViewer(job, identity) {
  if (!job || job.mode !== 'snapshot' || !identity?.viewerId) return false;
  return job.viewerId === identity.viewerId;
}

export class KeyedSerialExecutor {
  constructor() { this.tails = new Map(); }

  async run(key, action) {
    const lockKey = String(key);
    const prior = this.tails.get(lockKey) || Promise.resolve();
    const current = prior.catch(() => {}).then(action);
    this.tails.set(lockKey, current);
    try { return await current; }
    finally { if (this.tails.get(lockKey) === current) this.tails.delete(lockKey); }
  }
}
