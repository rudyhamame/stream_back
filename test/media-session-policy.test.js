import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaybackSupersededForViewer, isSnapshotSupersededForViewer, KeyedSerialExecutor, hlsChildRequestQuery, hlsSessionKey, samePlaybackViewer, scopedPlaybackViewerId } from '../media-session-policy.js';

test('HLS identity includes source, item, extension, and seek offset', () => {
  const base = hlsSessionKey('source', 'movie', '42', 'mp4', 0);
  assert.equal(base, hlsSessionKey('source', 'movie', '42', '.MP4', 0));
  assert.notEqual(base, hlsSessionKey('source', 'movie', '42', 'mkv', 0));
  assert.notEqual(base, hlsSessionKey('source', 'movie', '42', 'mp4', 60));
  assert.notEqual(base, hlsSessionKey('source', 'series', '42', 'mp4', 0));
  assert.notEqual(base, hlsSessionKey('source', 'movie', '42', 'mp4', 0, 'roku:hevc-main'));
});

test('HLS child requests preserve every value used by authentication and session identity', () => {
  const params = hlsChildRequestQuery({
    deviceToken: 'roku token',
    streamTicket: 'ticket/value',
    ext: 'm3u8',
    client: 'roku',
    caps: 'hevc-main,eac3',
    quality: '720',
    hlsFallback: ' FULL ',
    playbackAttemptId: '6',
    sessionId: 'roku-device-123-4',
    playbackClientId: 'phone-123',
  }, 90);
  assert.equal(params.get('deviceToken'), 'roku token');
  assert.equal(params.get('streamTicket'), 'ticket/value');
  assert.equal(params.get('ext'), 'm3u8');
  assert.equal(params.get('client'), 'roku');
  assert.equal(params.get('caps'), 'hevc-main,eac3');
  assert.equal(params.get('quality'), '720');
  assert.equal(params.get('hlsFallback'), 'full');
  assert.equal(params.get('playbackAttemptId'), '6');
  assert.equal(params.get('sessionId'), 'roku-device-123-4');
  assert.equal(params.get('playbackClientId'), 'phone-123');
  assert.equal(params.get('start'), '90');
  assert.equal(
    hlsSessionKey('source', 'movie', '42', params.get('ext'), Number(params.get('start'))),
    hlsSessionKey('source', 'movie', '42', 'm3u8', 90),
  );
});

test('HLS child requests preserve explicit diagnostic modes and reject unknown identities', () => {
  assert.equal(hlsChildRequestQuery({ hlsFallback: 'remux' }).get('hlsFallback'), 'remux');
  assert.equal(hlsChildRequestQuery({ hlsFallback: 'audio' }).get('hlsFallback'), 'audio');
  assert.equal(hlsChildRequestQuery({ hlsFallback: 'video' }).get('hlsFallback'), 'video');
  assert.equal(hlsChildRequestQuery({ hlsFallback: 'mystery' }).has('hlsFallback'), false);
});

test('Android playback identity is isolated from the account and Roku viewers', () => {
  assert.equal(scopedPlaybackViewerId('account-1', 'android', 'phone-123'), 'account-1:android:phone-123');
  assert.equal(scopedPlaybackViewerId('roku-1', 'roku', 'phone-123'), 'roku-1');
  assert.equal(scopedPlaybackViewerId('account-1', 'android', '../bad value'), 'account-1');
});

test('replacement is scoped to the requesting device or anonymous viewer', () => {
  const job = { deviceId: 'roku-1', viewerId: 'owner-1', viewers: new Map([['browser-1', 1]]) };
  assert.equal(samePlaybackViewer(job, { deviceId: 'roku-1', viewerId: 'owner-1' }), true);
  assert.equal(samePlaybackViewer(job, { deviceId: 'roku-2', viewerId: 'owner-1' }), false);
  assert.equal(samePlaybackViewer(job, { deviceId: '', viewerId: 'browser-1' }), true);
  assert.equal(samePlaybackViewer(job, { deviceId: '', viewerId: 'browser-2' }), false);
});

test('browser tabs on one account cannot supersede each other', () => {
  const first = scopedPlaybackViewerId('account-1', 'browser', 'tab-1');
  const second = scopedPlaybackViewerId('account-1', 'browser', 'tab-2');
  const job = { key: 'movie-1', persistent: true, deviceId: '', viewerId: first };
  assert.notEqual(first, second);
  assert.equal(isPlaybackSupersededForViewer(job, { viewerId: second }, 'movie-2'), false);
  assert.equal(isPlaybackSupersededForViewer(job, { viewerId: first }, 'movie-2'), true);
  assert.equal(hlsChildRequestQuery({ client: 'browser', playbackClientId: 'tab-2' }).get('playbackClientId'), 'tab-2');
});

test('a new Android episode replaces the prior job for the same account viewer', () => {
  const priorEpisode = { key: 'episode-1', persistent: true, deviceId: '', viewerId: 'account-1', viewers: new Map() };
  assert.equal(isPlaybackSupersededForViewer(priorEpisode, { deviceId: '', viewerId: 'account-1' }, 'episode-2'), true);
  assert.equal(isPlaybackSupersededForViewer(priorEpisode, { deviceId: '', viewerId: 'account-2' }, 'episode-2'), false);
  assert.equal(isPlaybackSupersededForViewer(priorEpisode, { deviceId: '', viewerId: 'account-1' }, 'episode-1'), false);
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
