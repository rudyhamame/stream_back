import test from 'node:test';
import assert from 'node:assert/strict';
import { confidentDirectPlayback, getPlaybackCapabilities, hlsPlaylistProfile, PlaybackClient } from '../playback-strategy.js';

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
