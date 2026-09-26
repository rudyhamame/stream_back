import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackClient, codecCompatibility, containerCompatibility, getPlaybackCapabilities } from '../playback-strategy.js';

const roku = getPlaybackCapabilities(PlaybackClient.ROKU);
const good = { videoCodec: 'h264', videoProfile: 'high', videoLevel: 41, pixelFormat: 'yuv420p', width: 1920, height: 1080, frameRate: '24/1', audioCodec: 'aac', audioChannels: 2, audioSampleRate: 48000 };

test('compatible video + audio is compatible', () => {
  assert.equal(codecCompatibility(good, roku).compatible, true);
});

test('incompatible audio or video makes codecs incompatible', () => {
  assert.equal(codecCompatibility({ ...good, audioCodec: 'dts' }, roku).compatible, false);
  assert.equal(codecCompatibility({ ...good, videoCodec: 'vp9' }, roku).compatible, false);
});

test('an unreadable probe is unknown, not incompatible', () => {
  const result = codecCompatibility({}, roku);
  assert.equal(result.known, false);
});

test('mkv container is not browser-direct but is on Roku', () => {
  assert.equal(containerCompatibility({ container: 'matroska' }, roku).compatible, true);
  assert.equal(containerCompatibility({ container: 'matroska' }, getPlaybackCapabilities(PlaybackClient.BROWSER)).compatible, false);
});
