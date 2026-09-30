import test from 'node:test';
import assert from 'node:assert/strict';
import { HLS_MODE, selectEnabledHlsStrategy, selectEnabledHlsForMedia } from '../stream-strategy-selection.js';

const all = { HLS_REMUX: true, HLS_VIDEO_TRANSCODE: true, HLS_AUDIO_TRANSCODE: true, HLS_FULL_TRANSCODE: true };
const choose = (facts, enabled = all, options = {}) => selectEnabledHlsStrategy({ ...facts, enabled, ...options });

test('compatible media uses the least costly checked HLS mode', () => {
  assert.equal(choose({}).strategy, HLS_MODE.REMUX);
  assert.equal(choose({}, { ...all, HLS_REMUX: false }).strategy, HLS_MODE.VIDEO);
});

test('audio conversion is selected only when its own or full checkbox is checked', () => {
  const facts = { videoCompatible: true, audioCompatible: false };
  assert.equal(choose(facts).strategy, HLS_MODE.AUDIO);
  assert.equal(choose(facts, { ...all, HLS_AUDIO_TRANSCODE: false }).strategy, HLS_MODE.FULL);
  assert.equal(choose(facts, { ...all, HLS_AUDIO_TRANSCODE: false, HLS_FULL_TRANSCODE: false }), null);
});

test('video conversion and downscaling require a checked video or full mode', () => {
  const facts = { videoCompatible: false, audioCompatible: true };
  assert.equal(choose(facts).strategy, HLS_MODE.VIDEO);
  assert.equal(choose({ downscale: true }).strategy, HLS_MODE.VIDEO);
  assert.equal(choose(facts, { ...all, HLS_VIDEO_TRANSCODE: false }).strategy, HLS_MODE.FULL);
  assert.equal(choose(facts, { ...all, HLS_VIDEO_TRANSCODE: false, HLS_FULL_TRANSCODE: false }), null);
});

test('both incompatible tracks require the checked full mode', () => {
  const facts = { videoCompatible: false, audioCompatible: false };
  assert.equal(choose(facts).strategy, HLS_MODE.FULL);
  assert.equal(choose(facts, { ...all, HLS_FULL_TRANSCODE: false }), null);
});

test('unknown probes never start speculative transcodes', () => {
  assert.equal(choose({ videoKnown: false }).strategy, HLS_MODE.REMUX);
  assert.equal(choose({ videoKnown: false }, { ...all, HLS_REMUX: false }), null);
});

test('explicit requests and fallbacks cannot bypass a disabled checkbox', () => {
  assert.equal(choose({}, { ...all, HLS_FULL_TRANSCODE: false }, { exact: HLS_MODE.FULL }), null);
  assert.equal(choose({}, all, { excluded: [HLS_MODE.REMUX, HLS_MODE.VIDEO] }).strategy, HLS_MODE.AUDIO);
  assert.equal(choose({}, {}, { exact: HLS_MODE.AUDIO }), null);
});

import { hlsCodecArgs } from '../playback-strategy.js';
const codec = decision => hlsCodecArgs(decision, { enabledStrategies: all });
const option = (args, key) => args[args.indexOf(key) + 1];

test('each checked mode emits the intended FFmpeg codec pair', () => {
  const remux = codec(choose({}));
  assert.equal(option(remux, '-c:v'), 'copy');
  assert.equal(option(remux, '-c:a'), 'copy');
  const audio = codec(choose({ audioCompatible: false }));
  assert.equal(option(audio, '-c:v'), 'copy');
  assert.equal(option(audio, '-c:a'), 'aac');
  const video = codec(choose({ videoCompatible: false }));
  assert.equal(option(video, '-c:v'), 'libx264');
  assert.equal(option(video, '-c:a'), 'copy');
  const full = codec(choose({ videoCompatible: false, audioCompatible: false }));
  assert.equal(option(full, '-c:v'), 'libx264');
  assert.equal(option(full, '-c:a'), 'aac');
});

test('codec generation rejects an unchecked conversion mode', () => {
  const decision = choose({ audioCompatible: false });
  assert.throws(() => hlsCodecArgs(decision, { enabledStrategies: { HLS_AUDIO_TRANSCODE: false } }), /not enabled/);
});


test('metadata and device capabilities lead to a policy-gated audio decision', () => {
  const capabilities = { client: 'roku', videoCodecs: new Set(['h264']), audioCodecs: new Set(['aac']), maxH264Level: 4.2, maxH264Width: 1920, maxH264Height: 1080, maxAacChannels: 2 };
  const metadata = { videoCodec: 'h264', videoProfile: 'High', videoLevel: 41, width: 1280, height: 720, frameRate: '24/1', pixelFormat: 'yuv420p', audioCodec: 'aac', audioChannels: 6, audioSampleRate: 48000 };
  assert.equal(selectEnabledHlsForMedia(metadata, capabilities, all).strategy, HLS_MODE.AUDIO);
  assert.equal(selectEnabledHlsForMedia(metadata, capabilities, { HLS_REMUX: true }), null);
});
