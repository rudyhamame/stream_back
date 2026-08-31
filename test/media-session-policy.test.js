import test from 'node:test';
import assert from 'node:assert/strict';
import { isSnapshotSupersededForViewer, KeyedSerialExecutor, hlsChildRequestQuery, hlsSessionKey, samePlaybackViewer } from '../media-session-policy.js';

test('HLS identity includes source, item, extension, and seek offset', () => {
  const base = hlsSessionKey('source', 'movie', '42', 'mp4', 0);
  assert.equal(base, hlsSessionKey('source', 'movie', '42', '.MP4', 0));
  assert.notEqual(base, hlsSessionKey('source', 'movie', '42', 'mkv', 0));
  assert.notEqual(base, hlsSessionKey('source', 'movie', '42', 'mp4', 60));
  assert.notEqual(base, hlsSessionKey('source', 'series', '42', 'mp4', 0));
});

test('HLS child requests preserve every value used by authentication and session identity', () => {
  const params = hlsChildRequestQuery({
    deviceToken: 'roku token',
    streamTicket: 'ticket/value',
    ext: 'm3u8',
  }, 90);
  assert.equal(params.get('deviceToken'), 'roku token');
  assert.equal(params.get('streamTicket'), 'ticket/value');
  assert.equal(params.get('ext'), 'm3u8');
  assert.equal(params.get('start'), '90');
  assert.equal(
    hlsSessionKey('source', 'movie', '42', params.get('ext'), Number(params.get('start'))),
    hlsSessionKey('source', 'movie', '42', 'm3u8', 90),
  );
});

test('replacement is scoped to the requesting device or anonymous viewer', () => {
  const job = { deviceId: 'roku-1', viewerId: 'owner-1', viewers: new Map([['browser-1', 1]]) };
  assert.equal(samePlaybackViewer(job, { deviceId: 'roku-1', viewerId: 'owner-1' }), true);
  assert.equal(samePlaybackViewer(job, { deviceId: 'roku-2', viewerId: 'owner-1' }), false);
  assert.equal(samePlaybackViewer(job, { deviceId: '', viewerId: 'browser-1' }), true);
  assert.equal(samePlaybackViewer(job, { deviceId: '', viewerId: 'browser-2' }), false);
});

test('a new preview supersedes only the same viewer snapshot slot', () => {
  const snapshot = { mode: 'snapshot', viewerId: 'roku-1' };
  assert.equal(isSnapshotSupersededForViewer(snapshot, { viewerId: 'roku-1' }), true);
  assert.equal(isSnapshotSupersededForViewer(snapshot, { viewerId: 'roku-2' }), false);
  assert.equal(isSnapshotSupersededForViewer({ ...snapshot, mode: 'remux' }, { viewerId: 'roku-1' }), false);
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
