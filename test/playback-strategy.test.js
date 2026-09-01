import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HlsStrategy,
  PlaybackClient,
  PlaybackStrategy,
  choosePlaybackStrategy,
  determineHlsStrategy,
  fallbackHlsStrategy,
  getPlaybackCapabilities,
  hlsCodecArgs,
  hlsInputArgs,
  hlsMuxerFlags,
  hlsPlaylistProfile,
  strategyUsesEncoding,
} from '../playback-strategy.js';

test('keeps range-capable proxy playback on the direct path', () => {
  assert.equal(choosePlaybackStrategy({ purpose: 'direct-proxy' }), PlaybackStrategy.DIRECT);
});

test('keeps FFmpeg fallback on independent, Roku-safe HLS segments', () => {
  assert.deepEqual(hlsPlaylistProfile(), {
    segmentSeconds: 2,
    initialSegmentSeconds: 0,
    listSize: 30,
    startupSegments: 1,
  });
  assert.deepEqual(hlsInputArgs(), ['-readrate', '1']);
  assert.equal(hlsInputArgs().includes('-readrate_initial_burst'), false);
  assert.match(hlsMuxerFlags(), /independent_segments/);
  assert.equal(hlsMuxerFlags().includes('split_by_time'), false);
});

test('uses remux for compatibility HLS', () => {
  assert.equal(choosePlaybackStrategy({ purpose: 'roku-hls' }), PlaybackStrategy.REMUX);
});

test('copies compatible H.264 and AAC without encoding', () => {
  const decision = determineHlsStrategy({ videoCodec: 'h264', videoProfile: 'High', pixelFormat: 'yuv420p', width: 1920, height: 1080, audioCodec: 'aac', audioChannels: 2, audioSampleRate: 48000 });
  assert.equal(decision.strategy, HlsStrategy.REMUX);
  assert.deepEqual(hlsCodecArgs(decision), ['-c:v', 'copy', '-c:a', 'copy']);
  assert.equal(strategyUsesEncoding(decision), false);
});

test('copies H.264 video while converting incompatible audio only', () => {
  const decision = determineHlsStrategy({ videoCodec: 'h264', pixelFormat: 'yuv420p', width: 1920, height: 1080, audioCodec: 'dts', audioChannels: 6 });
  assert.equal(decision.strategy, HlsStrategy.PARTIAL_TRANSCODE);
  assert.deepEqual(hlsCodecArgs(decision), ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']);
  assert.equal(strategyUsesEncoding(decision), true);
});

test('uses bounded H.264 conversion only for incompatible video', () => {
  const decision = determineHlsStrategy({ videoCodec: 'hevc', videoProfile: 'Main', pixelFormat: 'yuv420p', width: 1920, height: 1080, audioCodec: 'aac', audioChannels: 2 });
  const args = hlsCodecArgs(decision);
  assert.equal(decision.strategy, HlsStrategy.PARTIAL_TRANSCODE);
  assert.deepEqual(args.slice(0, 4), ['-c:v', 'libx264', '-preset', 'veryfast']);
  assert.deepEqual(args.slice(-2), ['-c:a', 'copy']);
  assert.equal(strategyUsesEncoding(decision), true);
});

test('fully transcodes only when both selected tracks are incompatible', () => {
  const decision = determineHlsStrategy({ videoCodec: 'hevc', videoProfile: 'Main 10', pixelFormat: 'yuv420p10le', width: 3840, height: 2160, audioCodec: 'dts', audioChannels: 6 });
  const args = hlsCodecArgs(decision);
  assert.equal(decision.strategy, HlsStrategy.FULL_TRANSCODE);
  assert.equal(args.includes('libx264'), true);
  assert.equal(args.includes('aac'), true);
});

test('MKV H.264 decisions depend on codecs rather than the container', () => {
  const roku = getPlaybackCapabilities(PlaybackClient.ROKU);
  const aac = determineHlsStrategy({ videoCodec: 'h264', pixelFormat: 'yuv420p', width: 1280, height: 720, audioCodec: 'aac', audioChannels: 2, audioSampleRate: 48000 }, roku);
  const dts = determineHlsStrategy({ videoCodec: 'h264', pixelFormat: 'yuv420p', width: 1280, height: 720, audioCodec: 'dts', audioChannels: 6 }, roku);
  assert.deepEqual(hlsCodecArgs(aac), ['-c:v', 'copy', '-c:a', 'copy']);
  assert.deepEqual(hlsCodecArgs(dts), ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']);
});

test('Roku preserves Dolby audio only when the current device reports support', () => {
  const metadata = { videoCodec: 'h264', pixelFormat: 'yuv420p', width: 1920, height: 1080, audioCodec: 'eac3', audioChannels: 6 };
  assert.equal(determineHlsStrategy(metadata, getPlaybackCapabilities(PlaybackClient.ROKU)).audioMode, 'transcode');
  assert.equal(determineHlsStrategy(metadata, getPlaybackCapabilities(PlaybackClient.ROKU, ['eac3'])).audioMode, 'copy');
});

test('HEVC copy is gated by client report, profile, bit depth, and dimensions', () => {
  const main = { videoCodec: 'hevc', videoProfile: 'Main', videoLevel: 153, pixelFormat: 'yuv420p', width: 3840, height: 2160, frameRate: '60000/1001', audioCodec: 'aac', audioChannels: 2 };
  const main10 = { ...main, videoProfile: 'Main 10', pixelFormat: 'yuv420p10le' };
  assert.equal(determineHlsStrategy(main, getPlaybackCapabilities(PlaybackClient.ROKU)).videoMode, 'transcode');
  assert.equal(determineHlsStrategy(main, getPlaybackCapabilities(PlaybackClient.ROKU, ['hevc-main-51'])).videoMode, 'copy');
  assert.equal(determineHlsStrategy(main, getPlaybackCapabilities(PlaybackClient.ROKU, ['hevc-main-41'])).videoMode, 'transcode');
  assert.equal(determineHlsStrategy(main10, getPlaybackCapabilities(PlaybackClient.ROKU, ['hevc-main-51'])).videoMode, 'transcode');
  assert.equal(determineHlsStrategy(main10, getPlaybackCapabilities(PlaybackClient.ROKU, ['hevc-main10-51'])).videoMode, 'copy');
});

test('unknown probe metadata fails safe instead of using the file extension', () => {
  assert.equal(determineHlsStrategy({}).strategy, HlsStrategy.FULL_TRANSCODE);
});

test('fallbacks are progressive and bounded', () => {
  const remux = { videoMode: 'copy', audioMode: 'copy', strategy: HlsStrategy.REMUX };
  const partial = fallbackHlsStrategy(remux);
  const full = fallbackHlsStrategy(partial);
  assert.deepEqual([partial.videoMode, partial.audioMode, partial.strategy], ['copy', 'transcode', HlsStrategy.PARTIAL_TRANSCODE]);
  assert.deepEqual([full.videoMode, full.audioMode, full.strategy], ['transcode', 'transcode', HlsStrategy.FULL_TRANSCODE]);
});
