import test from 'node:test';
import assert from 'node:assert/strict';
import { hlsCodecArgs, hlsManifestStartupTimeoutMs, HlsStrategy, PlaybackClient } from '../playback-strategy.js';

const remux = { strategy: HlsStrategy.REMUX, videoMode: 'copy', audioMode: 'copy' };
test('video transcode stays disabled for Android and Browser; HLS copies source codecs', () => {
  const decision = { ...remux, strategy: HlsStrategy.VIDEO_TRANSCODE, videoMode: 'transcode' };
  const args = hlsCodecArgs(decision);
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
});

test('disabled video transcode does not change HLS startup budget', () => {
  const budget = (client, strategy) => hlsManifestStartupTimeoutMs({ seekableVod: true, client, strategy });
  assert.equal(budget(PlaybackClient.ANDROID, HlsStrategy.VIDEO_TRANSCODE), 35_000);
  assert.equal(budget(PlaybackClient.ANDROID, HlsStrategy.REMUX), 16_000);
  assert.equal(budget(PlaybackClient.ROKU, HlsStrategy.VIDEO_TRANSCODE), 16_000);
});
