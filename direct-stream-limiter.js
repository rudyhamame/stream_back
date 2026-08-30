import { MediaCapacityError } from './media-job-manager.js';

export class DirectStreamLimiter {
  constructor({ maxTotal = 8, maxPerSource = 4 } = {}) {
    this.maxTotal = maxTotal;
    this.maxPerSource = maxPerSource;
    this.activeCount = 0;
    this.bySource = new Map();
  }

  acquire(sourceId) {
    const key = String(sourceId);
    const sourceCount = this.bySource.get(key) || 0;
    if (this.activeCount >= this.maxTotal) throw new MediaCapacityError('Direct-stream capacity is currently full');
    if (sourceCount >= this.maxPerSource) throw new MediaCapacityError('Provider direct-stream capacity is currently full');
    this.activeCount += 1;
    this.bySource.set(key, sourceCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
      const remaining = Math.max(0, (this.bySource.get(key) || 1) - 1);
      if (remaining === 0) this.bySource.delete(key); else this.bySource.set(key, remaining);
    };
  }
}
