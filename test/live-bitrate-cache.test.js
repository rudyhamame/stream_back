import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveBitrateCache } from '../live-bitrate-cache.js';
import { HlsBitrateSource, HlsPlaylistType } from '../hls-native-proxy.js';

const config = { sampleTarget: 2, rollingSamples: 3, safetyFactor: 1.1, ttlMs: 60_000 };

test('Live bitrate cache measures session segments and retains the rolling samples', () => {
  const cache = createLiveBitrateCache(config);
  const session = { bitrateSamples: new Map() };
  const first = { sequence: 1, durationSec: 2, url: 'first.ts' };
  const second = { sequence: 2, durationSec: 2, url: 'second.ts' };
  assert.equal(cache.recordSegment('provider-a', 'channel-1', session, first, 1_000_000), null);
  const measured = cache.recordSegment('provider-a', 'channel-1', session, second, 1_200_000);
  assert.equal(measured.bitrateSource, HlsBitrateSource.MEASURED_SEGMENTS);
  assert.equal(measured.sampleCount, 2);
  assert.equal(cache.get('provider-a', 'channel-1'), measured);
  assert.equal(cache.get('provider-b', 'channel-1'), null);
  assert.equal(measured.samples.length, 2);
  assert.equal(measured.playlistType, HlsPlaylistType.MEDIA);
});

test('Live bitrate cache preserves small measurement changes and expires old entries', () => {
  const cache = createLiveBitrateCache(config);
  const details = {
    playlistType: HlsPlaylistType.MEDIA,
    bandwidth: 4_000_000,
    averageBandwidth: 3_000_000,
    bitrateSource: HlsBitrateSource.MEASURED_SEGMENTS,
    sampleCount: 2,
  };
  const first = cache.store('provider-a', 'channel-1', details);
  const second = cache.store('provider-a', 'channel-1', { ...details, bandwidth: 4_100_000, averageBandwidth: 3_100_000 });
  assert.equal(second.bandwidth, first.bandwidth);
  assert.equal(second.averageBandwidth, first.averageBandwidth);
  cache.evict(second.expiresAt + 1);
  assert.equal(cache.get('provider-a', 'channel-1'), null);
  assert.equal(cache.measurements.size, 0);
});
