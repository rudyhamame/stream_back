import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HlsStrategy,
  PlaybackStrategy,
  choosePlaybackStrategy,
  determineHlsStrategy,
  determineVodHlsStrategy,
  hlsCodecArgs,
  hlsInputArgs,
  hlsMuxerFlags,
  hlsPlaylistProfile,
  strategyUsesEncoding,
} from '../playback-strategy.js';

test('remuxes MP4-family VOD without opening a codec probe', () => {
  for (const extension of ['mp4', 'M4V', 'mov']) {
    const decision = determineVodHlsStrategy(extension);
    assert.equal(decision.strategy, HlsStrategy.REMUX);
    assert.deepEqual(hlsCodecArgs(decision), ['-c:v', 'copy', '-c:a', 'copy']);
    assert.equal(strategyUsesEncoding(decision), false);
  }
});

test('retains full compatibility mode for unpredictable VOD containers and fallback', () => {
  assert.equal(determineVodHlsStrategy('mkv').strategy, HlsStrategy.FULL_TRANSCODE);
  assert.equal(determineVodHlsStrategy('mp4', true).strategy, HlsStrategy.FULL_TRANSCODE);
});

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

test('uses remux for compatibility HLS and transcode only for previews', () => {
  assert.equal(choosePlaybackStrategy({ purpose: 'roku-hls' }), PlaybackStrategy.REMUX);
  assert.equal(choosePlaybackStrategy({ purpose: 'preview' }), PlaybackStrategy.TRANSCODE);
});

test('copies compatible H.264 and AAC without encoding', () => {
  const decision = determineHlsStrategy({ videoCodec: 'h264', audioCodec: 'aac' });
  assert.equal(decision.strategy, HlsStrategy.REMUX);
  assert.deepEqual(hlsCodecArgs(decision), ['-c:v', 'copy', '-c:a', 'copy']);
  assert.equal(strategyUsesEncoding(decision), false);
});

test('copies H.264 video while converting incompatible audio only', () => {
  const decision = determineHlsStrategy({ videoCodec: 'h264', audioCodec: 'eac3' });
  assert.equal(decision.strategy, HlsStrategy.PARTIAL_TRANSCODE);
  assert.deepEqual(hlsCodecArgs(decision), ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']);
  assert.equal(strategyUsesEncoding(decision), true);
});

test('uses bounded H.264 conversion only for incompatible video', () => {
  const decision = determineHlsStrategy({ videoCodec: 'hevc', audioCodec: 'aac' });
  const args = hlsCodecArgs(decision);
  assert.equal(decision.strategy, HlsStrategy.PARTIAL_TRANSCODE);
  assert.deepEqual(args.slice(0, 4), ['-c:v', 'libx264', '-preset', 'veryfast']);
  assert.deepEqual(args.slice(-2), ['-c:a', 'copy']);
  assert.equal(strategyUsesEncoding(decision), true);
});

test('fully transcodes only when both selected tracks are incompatible', () => {
  const decision = determineHlsStrategy({ videoCodec: 'hevc', audioCodec: 'eac3' });
  const args = hlsCodecArgs(decision);
  assert.equal(decision.strategy, HlsStrategy.FULL_TRANSCODE);
  assert.equal(args.includes('libx264'), true);
  assert.equal(args.includes('aac'), true);
});
