import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { getPlaybackCapabilities } from '../playback-strategy.js';
import { liveCodecFacts, selectLiveHlsStrategy, probeLiveSegment, pinnedLiveGeneration, activeLiveStrategy } from '../live-hls-compatibility.js';

const caps = getPlaybackCapabilities('roku');
const enabled = { HLS_REMUX: true, HLS_VIDEO_TRANSCODE: true, HLS_AUDIO_TRANSCODE: true, HLS_FULL_TRANSCODE: true };
const metadata = { videoCodec: 'h264', videoProfile: 'High', videoLevel: 41,
  pixelFormat: 'yuv420p', width: 1920, height: 1080, frameRate: '25/1', audioCodec: 'mp2' };

test('live MP2 audio cannot be kept by native Direct or video-only conversion', () => {
  assert.equal(liveCodecFacts(metadata, caps).audioCompatible, false);
  assert.equal(selectLiveHlsStrategy(metadata, caps, enabled).strategy, 'HLS_AUDIO_TRANSCODE');
  assert.equal(selectLiveHlsStrategy(metadata, caps, enabled, { decoderFailure: 'decoder-video' }).strategy, 'HLS_FULL_TRANSCODE');
  assert.equal(selectLiveHlsStrategy(metadata, caps, { HLS_VIDEO_TRANSCODE: true }), null);
});

test('live unknown facts do not authorize speculative video conversion', () => {
  assert.equal(selectLiveHlsStrategy({}, caps, enabled).strategy, 'HLS_REMUX');
  assert.equal(selectLiveHlsStrategy({}, caps, { HLS_VIDEO_TRANSCODE: true }), null);
  assert.equal(selectLiveHlsStrategy({}, caps, enabled, { decoderFailure: 'decoder-video' }).strategy, 'HLS_VIDEO_TRANSCODE');
});

test('compatible native audio and video remain compatible', () => {
  const facts = liveCodecFacts({ ...metadata, audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2 }, caps);
  assert.equal(facts.audioCompatible && facts.videoCompatible, true);
});

test('live status reports the active scoped job instead of defaulting to Direct', () => {
  const identity = { userId: 'account:a', viewerId: 'roku:a' };
  const native = { ...identity, manifests: new Map([['url', 'manifest']]), viewers: new Set(['roku:a']), loadId: '2' };
  const job = { ...identity, sourceId: 'provider:a', mediaId: '182', kind: 'channel',
    hlsStrategy: 'HLS_VIDEO_TRANSCODE', hlsVideoMode: 'transcode', hlsAudioMode: 'copy' };
  assert.equal(activeLiveStrategy([job], 'provider:a', '182', identity, native, '2').playbackStrategy, 'HLS_VIDEO_TRANSCODE');
  assert.equal(activeLiveStrategy([], 'provider:a', '182', identity, native, '2').playbackStrategy, 'DIRECT');
  assert.equal(activeLiveStrategy([], 'provider:a', '182', identity, native, 'old').playbackStrategy, '');
  assert.equal(activeLiveStrategy([job], 'provider:b', '182', identity).playbackStrategy, '');
  assert.equal(activeLiveStrategy([job], 'provider:a', '182', { ...identity, userId: 'account:b' }).playbackStrategy, '');
  assert.equal(activeLiveStrategy([job], 'provider:a', '182', { ...identity, viewerId: 'roku:b' }).playbackStrategy, '');
  assert.equal(activeLiveStrategy([{ ...job, kind: 'movie', hlsStrategy: 'HLS_FULL_TRANSCODE' }],
    'provider:a', '182', identity, null, '', 'movie').playbackStrategy, 'HLS_FULL_TRANSCODE');
});

test('finished live media polls retain the same generation and enforce ownership/policy', () => {
  const identity = { userId: 'account:a', viewerId: 'roku:a' };
  const job = { ...identity, sourceId: 'provider:a', mediaId: '1', kind: 'channel',
    hlsStrategy: 'HLS_AUDIO_TRANSCODE', finished: true, generationId: 'old' };
  assert.equal(pinnedLiveGeneration(job, 'provider:a', '1', identity, enabled).job, job);
  assert.equal(pinnedLiveGeneration(job, 'provider:a', '2', identity, enabled).status, 404);
  assert.equal(pinnedLiveGeneration(job, 'provider:a', '1', { ...identity, userId: 'account:b' }, enabled).status, 404);
  assert.equal(pinnedLiveGeneration(job, 'provider:a', '1', { ...identity, viewerId: 'roku:b' }, enabled).status, 404);
  assert.equal(pinnedLiveGeneration(job, 'provider:a', '1', identity, {}).status, 409);
});

test('probe identifies actual MPEG Layer II in already fetched TS bytes', async () => {
  const body = execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'mp2', '-f', 'mpegts', 'pipe:1']);
  const actual = await probeLiveSegment(body);
  assert.equal(actual.videoCodec, 'h264');
  assert.equal(actual.audioCodec, 'mp2');
  assert.equal(selectLiveHlsStrategy(actual, caps, enabled).strategy, 'HLS_AUDIO_TRANSCODE');
  assert.deepEqual(await probeLiveSegment(Buffer.from('invalid TS')), {});
});
