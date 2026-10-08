import { promises as fs } from 'node:fs';
import path from 'node:path';
import { measuredHlsPreparedRange } from './hls-prepared-range.js';

// Housekeeping and transport polling can ask for the same generation at once.
// Share only an in-flight read, without caching a time range or retaining jobs.
export function createHlsPreparedRangeReader({ readFile = fs.readFile, access = fs.access } = {}) {
  const pending = new WeakMap();
  return function readHlsPreparedRange(job) {
    if (!job?.manifest || !job.generationId) return Promise.resolve(null);
    const existing = pending.get(job);
    if (existing) return existing;
    const request = Promise.resolve().then(async () => {
      try {
        const manifest = await readFile(job.manifest, 'utf8');
        const measured = measuredHlsPreparedRange(manifest, job.generationId, job.startSeconds, job.preparedTimeline);
        if (!measured || measured.nextSequence === 0) return null;
        const extension = job.hlsSegmentType === 'fmp4' ? 'm4s' : 'ts';
        await access(path.join(job.directory, `segment-${String(measured.nextSequence - 1).padStart(6, '0')}.${extension}`));
        if (!job.preparedTimeline || measured.nextSequence > job.preparedTimeline.nextSequence
          || (measured.nextSequence === job.preparedTimeline.nextSequence && measured.availableStartSeconds > job.preparedTimeline.availableStartSeconds)) {
          job.preparedTimeline = measured;
        }
        return job.preparedTimeline;
      } catch {
        return null;
      }
    }).finally(() => pending.delete(job));
    pending.set(job, request);
    return request;
  };
}
