import test from 'node:test';
import assert from 'node:assert/strict';
import { confidentDirectPlayback, determineHlsStrategy, fallbackHlsStrategy, getPlaybackCapabilities, hlsPlaylistProfile, PlaybackClient, HlsStrategy } from '../playback-strategy.js';

test('live previews can start from the first remuxed segment', () => {
  assert.equal(hlsPlaylistProfile({ preview: true }).startupSegments, 1);
  assert.equal(hlsPlaylistProfile().startupSegments, 3);
  assert.equal(hlsPlaylistProfile({ preview: true }).segmentSeconds, 2);
});

const rokuCompatibleMedia = {
  videoCodec: 'h264', videoProfile: 'High', videoLevel: 31,
  pixelFormat: 'yuv420p', width: 1280, height: 640, frameRate: '25/1',
  audioCodec: 'aac', audioChannels: 2, audioSampleRate: 48000,
};

test('HLS codec matrix never encodes: incompatible audio still remuxes with copy', () => {
  const roku = getPlaybackCapabilities(PlaybackClient.ROKU);
  assert.equal(determineHlsStrategy(rokuCompatibleMedia, roku).strategy, HlsStrategy.REMUX);
  const surround = determineHlsStrategy({ ...rokuCompatibleMedia, audioChannels: 6 }, roku);
  assert.equal(surround.videoMode, 'copy');
  assert.equal(surround.audioMode, 'copy');
  assert.equal(surround.strategy, HlsStrategy.REMUX);
  const incompatibleVideo = determineHlsStrategy({ ...rokuCompatibleMedia, videoCodec: 'mpeg2video' }, roku);
  assert.equal(incompatibleVideo.videoMode, 'copy');
  assert.equal(incompatibleVideo.audioMode, 'copy');
  assert.equal(incompatibleVideo.strategy, HlsStrategy.REMUX);
  assert.equal(determineHlsStrategy({ ...rokuCompatibleMedia, videoCodec: 'hevc', audioCodec: 'dts' }, roku).strategy, HlsStrategy.REMUX);
  assert.equal(determineHlsStrategy(rokuCompatibleMedia, getPlaybackCapabilities(PlaybackClient.BROWSER)).strategy, HlsStrategy.REMUX);
  assert.equal(determineHlsStrategy(rokuCompatibleMedia, getPlaybackCapabilities(PlaybackClient.ANDROID)).strategy, HlsStrategy.REMUX);
  assert.equal(hlsPlaylistProfile({ client: PlaybackClient.BROWSER }).startupSegments, 4);
  assert.equal(hlsPlaylistProfile({ client: PlaybackClient.ROKU }).startupSegments, 3);
});

test('Roku bounded HLS fallback remains remux-only', () => {
  const remux = determineHlsStrategy(rokuCompatibleMedia, getPlaybackCapabilities(PlaybackClient.ROKU));
  const retry = fallbackHlsStrategy(remux);
  assert.equal(retry.strategy, HlsStrategy.REMUX);
  assert.equal(retry.videoMode, 'copy');
  assert.equal(retry.audioMode, 'copy');
});

test('fallback for incompatible audio is remux with copy (no audio transcode)', () => {
  const decision = determineHlsStrategy({ ...rokuCompatibleMedia, audioChannels: 6 }, getPlaybackCapabilities(PlaybackClient.BROWSER));
  const retry = fallbackHlsStrategy(decision);
  assert.equal(retry.strategy, HlsStrategy.REMUX);
  assert.equal(retry.videoMode, 'copy');
  assert.equal(retry.audioMode, 'copy');
});

test('direct playback trusts the probed container over a misleading catalog extension', () => {
  const capabilities = getPlaybackCapabilities(PlaybackClient.ROKU);
  const rejected = confidentDirectPlayback({ ...rokuCompatibleMedia, container: 'mpegts' }, capabilities, 'mp4');
  assert.equal(rejected.compatible, false);
  assert.match(rejected.reason, /container mpegts/);
});

test('direct playback normalizes ffprobe Matroska format names', () => {
  const capabilities = getPlaybackCapabilities(PlaybackClient.ROKU);
  const accepted = confidentDirectPlayback({ ...rokuCompatibleMedia, container: 'matroska,webm' }, capabilities, 'mp4');
  assert.equal(accepted.compatible, true);
  assert.equal(confidentDirectPlayback({ ...rokuCompatibleMedia, container: 'matroska,webm' }, getPlaybackCapabilities(PlaybackClient.ANDROID), 'mkv').compatible, true);
  assert.equal(confidentDirectPlayback({ ...rokuCompatibleMedia, container: 'matroska,webm' }, getPlaybackCapabilities(PlaybackClient.BROWSER), 'mkv').compatible, false);
});
