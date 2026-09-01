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
  if (startSeconds > 0) params.set('start', String(startSeconds));
  return params;
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
