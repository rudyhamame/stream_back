import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaMaintenance } from '../media-maintenance.js';

test('maintenance bounds concurrent work and suppresses overlapping cycles', async () => {
  const jobs = Array.from({ length: 7 }, (_, index) => index);
  const processed = [];
  let active = 0;
  let peak = 0;
  let sweeps = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const run = createMediaMaintenance({
    sweep: async () => { sweeps++; },
    listJobs: () => jobs,
    concurrency: 2,
    maintain: async job => {
      active++;
      peak = Math.max(peak, active);
      await gate;
      processed.push(job);
      active--;
    },
  });
  const first = run();
  await Promise.resolve();
  assert.equal(await run(), false);
  assert.equal(sweeps, 1);
  assert.equal(peak, 2);
  release();
  assert.equal(await first, true);
  assert.equal(peak, 2);
  assert.deepEqual(processed.sort(), jobs);
});

test('a sweep rejection is contained and the next cycle can recover', async () => {
  let fail = true;
  const errors = [];
  let processed = 0;
  const run = createMediaMaintenance({
    sweep: async () => { if (fail) throw new Error('disk temporarily unavailable'); },
    listJobs: () => [1],
    maintain: async () => { processed++; },
    onError: error => errors.push(error.message),
  });
  assert.equal(await run(), false);
  assert.equal(processed, 0);
  fail = false;
  assert.equal(await run(), true);
  assert.equal(processed, 1);
  assert.deepEqual(errors, ['disk temporarily unavailable']);
});

test('one failed generation does not skip maintenance for the remaining jobs', async () => {
  const errors = [];
  const processed = [];
  const run = createMediaMaintenance({
    sweep: async () => {},
    listJobs: () => [1, 2, 3],
    maintain: async job => { processed.push(job); if (job === 2) throw new Error('generation retired'); },
    onError: error => errors.push(error.message),
  });
  assert.equal(await run(), true);
  assert.deepEqual(processed.sort(), [1, 2, 3]);
  assert.deepEqual(errors, ['generation retired']);
});
