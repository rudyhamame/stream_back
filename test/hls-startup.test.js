import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForHlsManifest } from '../hls-startup.js';
import { hlsInputArgs } from '../playback-strategy.js';

function scenario({ readyAt = Infinity, progress = () => 0, finishedAt = Infinity, endlist = false, timeoutMs = 16_000, maxWaitMs = 23_000, signal, onSleep } = {}) {
  let elapsed = 0;
  const pending = waitForHlsManifest('fixture.m3u8', {
    timeoutMs, maxWaitMs, requiredSegments: 3, signal,
    generatedSeconds: () => progress(elapsed), isFinished: () => elapsed >= finishedAt,
  }, {
    now: () => elapsed,
    sleep: async () => { elapsed += 100; onSleep?.(elapsed); },
    readManifest: async () => elapsed >= readyAt
      ? `#EXTM3U\nsegment-000000.ts\n${endlist ? '#EXT-X-ENDLIST' : 'segment-000001.ts\nsegment-000002.ts'}`
      : '#EXTM3U\n',
  });
  return { pending, elapsed: () => elapsed };
}

test('an advancing long-GOP remux finishes without the old 16-second timeout', async () => {
  const run = scenario({ readyAt: 20_000, progress: ms => ms / 1000 });
  assert.equal(await run.pending, true);
  assert.equal(run.elapsed(), 20_000);
});

test('no output progress retains the original bounded timeout', async () => {
  const run = scenario();
  assert.equal(await run.pending, false);
  assert.equal(run.elapsed(), 16_000);
});

test('a stalled generator expires its inactivity budget after its last advance', async () => {
  const run = scenario({ timeoutMs: 4000, progress: ms => Math.min(ms, 3000) / 1000 });
  assert.equal(await run.pending, false);
  assert.equal(run.elapsed(), 7000);
});

test('continuous progress cannot extend the absolute startup cap', async () => {
  const run = scenario({ progress: ms => ms / 1000 });
  assert.equal(await run.pending, false);
  assert.equal(run.elapsed(), 23_000);
});

test('a short final ENDLIST is playable without three segments', async () => {
  const run = scenario({ readyAt: 0, endlist: true, finishedAt: 0 });
  assert.equal(await run.pending, true);
});

test('finished FFmpeg and aborted requests do not keep polling', async () => {
  const ended = scenario({ finishedAt: 500 });
  assert.equal(await ended.pending, false);
  assert.equal(ended.elapsed(), 500);
  const controller = new AbortController();
  const reason = new Error('superseded request');
  const cancelled = scenario({ signal: controller.signal, onSleep: () => controller.abort(reason) });
  await assert.rejects(cancelled.pending, error => error === reason);
  assert.equal(cancelled.elapsed(), 100);
});

test('VOD burst returns to real-time pacing and does not affect live input', () => {
  assert.deepEqual(hlsInputArgs(false, 12, 1), ['-readrate', '1', '-readrate_initial_burst', '12']);
  assert.deepEqual(hlsInputArgs(false, 0, 1), ['-readrate', '1']);
  const live = hlsInputArgs(true, 12, 1);
  assert.ok(!live.includes('-readrate'));
  assert.ok(!live.includes('-readrate_initial_burst'));
});
