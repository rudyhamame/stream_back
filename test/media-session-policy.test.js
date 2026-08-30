import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyedSerialExecutor, hlsSessionKey, samePlaybackViewer } from '../media-session-policy.js';

test('HLS identity includes source, item, extension, and seek offset', () => {
  const base = hlsSessionKey('source', 'movie', '42', 'mp4', 0);
  assert.equal(base, hlsSessionKey('source', 'movie', '42', '.MP4', 0));
  assert.notEqual(base, hlsSessionKey('source', 'movie', '42', 'mkv', 0));
  assert.notEqual(base, hlsSessionKey('source', 'movie', '42', 'mp4', 60));
  assert.notEqual(base, hlsSessionKey('source', 'series', '42', 'mp4', 0));
});

test('replacement is scoped to the requesting device or anonymous viewer', () => {
  const job = { deviceId: 'roku-1', viewerId: 'owner-1', viewers: new Map([['browser-1', 1]]) };
  assert.equal(samePlaybackViewer(job, { deviceId: 'roku-1', viewerId: 'owner-1' }), true);
  assert.equal(samePlaybackViewer(job, { deviceId: 'roku-2', viewerId: 'owner-1' }), false);
  assert.equal(samePlaybackViewer(job, { deviceId: '', viewerId: 'browser-1' }), true);
  assert.equal(samePlaybackViewer(job, { deviceId: '', viewerId: 'browser-2' }), false);
});

test('serializes startup for one provider source without blocking another source', async () => {
  const executor = new KeyedSerialExecutor();
  let sourceAActive = 0;
  let sourceAMax = 0;
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const first = executor.run('source-a', async () => {
    sourceAActive += 1;
    sourceAMax = Math.max(sourceAMax, sourceAActive);
    await gate;
    sourceAActive -= 1;
    return 'first';
  });
  const second = executor.run('source-a', async () => {
    sourceAActive += 1;
    sourceAMax = Math.max(sourceAMax, sourceAActive);
    sourceAActive -= 1;
    return 'second';
  });
  const otherSource = executor.run('source-b', async () => 'other');
  assert.equal(await otherSource, 'other');
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(sourceAMax, 1);
});
