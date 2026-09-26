import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlaybackCapabilities, hlsCodecArgs, hlsManifestStartupTimeoutMs, HlsStrategy, needsHlsVideoTimestampRepair, PlaybackClient } from '../playback-strategy.js';

const remux = { strategy: HlsStrategy.REMUX, videoMode: 'copy', audioMode: 'copy' };
const media = { container: 'matroska,webm', videoCodec: 'h264', audioCodec: 'aac' };
const repair = (client, metadata = media, seekableVod = true) => needsHlsVideoTimestampRepair({
  client, metadata, seekableVod, capabilities: getPlaybackCapabilities(client), extension: 'mkv', decision: remux,
});

test('Android HLS repairs H.264/AAC timing for MKV and Direct-to-HLS fallback', () => {
  assert.equal(repair(PlaybackClient.ANDROID), true);
  assert.equal(repair(PlaybackClient.ANDROID, { ...media, container: 'mov,mp4' }), true);
});

test('repair preserves browser eligibility and excludes Roku and live channels', () => {
  assert.equal(repair(PlaybackClient.BROWSER), true);
  assert.equal(repair(PlaybackClient.BROWSER, { ...media, container: 'mov,mp4' }), false);
  assert.equal(repair(PlaybackClient.ROKU), false);
  assert.equal(repair(PlaybackClient.ANDROID, media, false), false);
  assert.equal(repair(PlaybackClient.BROWSER, media, false), false);
});

test('unknown codecs and non-H.264/AAC pairs retain the existing HLS path', () => {
  assert.equal(repair(PlaybackClient.ANDROID, {}), false);
  assert.equal(repair(PlaybackClient.ANDROID, { ...media, audioCodec: 'ac3' }), false);
  assert.equal(repair(PlaybackClient.ANDROID, { ...media, videoCodec: 'hevc' }), false);
});

test('timing repair encodes H.264 with two-second keyframes and copies audio', () => {
  const decision = { ...remux, strategy: HlsStrategy.VIDEO_TRANSCODE, videoMode: 'transcode' };
  const args = hlsCodecArgs(decision, { allowVideoTimestampRepair: true });
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  assert.equal(args[args.indexOf('-force_key_frames') + 1], 'expr:gte(t,n_forced*2)');
  const defaultArgs = hlsCodecArgs(decision);
  assert.equal(defaultArgs[defaultArgs.indexOf('-c:v') + 1], 'copy');
});

test('Android video repair gets the browser startup budget without changing remux or Roku', () => {
  const budget = (client, strategy) => hlsManifestStartupTimeoutMs({ seekableVod: true, client, strategy });
  assert.equal(budget(PlaybackClient.ANDROID, HlsStrategy.VIDEO_TRANSCODE), 35_000);
  assert.equal(budget(PlaybackClient.ANDROID, HlsStrategy.REMUX), 16_000);
  assert.equal(budget(PlaybackClient.ROKU, HlsStrategy.VIDEO_TRANSCODE), 16_000);
});
