import { createHash } from 'node:crypto';

export function hlsSessionKey(sourceId, kind, id, extension, startSeconds = 0) {
  const normalizedExtension = String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return createHash('sha256')
    .update(`${sourceId}:${kind}:${id}:${normalizedExtension}:${startSeconds}`)
    .digest('hex')
    .slice(0, 24);
}

export function samePlaybackViewer(job, identity) {
  if (!job || !identity) return false;
  if (identity.deviceId) return job.deviceId === identity.deviceId;
  if (!identity.viewerId) return false;
  return job.viewerId === identity.viewerId || job.viewers?.has(identity.viewerId) === true;
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
