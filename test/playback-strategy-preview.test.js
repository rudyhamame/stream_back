import test from 'node:test';
import assert from 'node:assert/strict';
import { confidentDirectPlayback, determineHlsStrategy, getPlaybackCapabilities, hlsPlaylistProfile, PlaybackClient, HlsStrategy } from '../playback-strategy.js';

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

test('browser HLS copies compatible video and converts only incompatible audio', () => {
  const browser = getPlaybackCapabilities(PlaybackClient.BROWSER);
  assert.equal(determineHlsStrategy(rokuCompatibleMedia, browser).strategy, HlsStrategy.REMUX);
  const surround = determineHlsStrategy({ ...rokuCompatibleMedia, audioChannels: 6 }, browser);
  assert.equal(surround.videoMode, 'copy');
  assert.equal(surround.audioMode, 'transcode');
  assert.equal(determineHlsStrategy({ ...rokuCompatibleMedia, videoCodec: 'hevc', audioCodec: 'dts' }, browser).strategy, HlsStrategy.FULL_TRANSCODE);
  assert.equal(determineHlsStrategy(rokuCompatibleMedia, getPlaybackCapabilities(PlaybackClient.ROKU)).strategy, HlsStrategy.FULL_TRANSCODE);
  assert.equal(hlsPlaylistProfile({ client: PlaybackClient.BROWSER }).startupSegments, 1);
  assert.equal(hlsPlaylistProfile({ client: PlaybackClient.ROKU }).startupSegments, 3);
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
});
