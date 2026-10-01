import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredHlsPreparedRange } from '../hls-prepared-range.js';
import { isStreamingRoute } from '../streaming-route-policy.js';

const manifest = (sequence, durations) => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:' + sequence + '\n' + durations.map((seconds, index) =>
  `#EXTINF:${seconds},\nsegment-${String(sequence + index).padStart(6, '0')}.ts\n`).join('');

test('prepared range includes only completed segment durations at the absolute restart position', () => {
  const text = manifest(0, [2.04, 7.96]) + '#EXTINF:8,\n';
  const range = measuredHlsPreparedRange(text, 'generation-a', 3104.7);
  assert.equal(range.endSeconds, 3114.7);
  assert.equal(range.nextSequence, 2);
});

test('overlapping and rolling manifests advance one bounded cursor without double-counting', () => {
  const first = measuredHlsPreparedRange(manifest(0, [3, 7]), 'a', 100);
  const same = measuredHlsPreparedRange(manifest(0, [3, 7]), 'a', 100, first);
  assert.deepEqual(same, first);
  const rolling = measuredHlsPreparedRange(manifest(1, [7, 4]), 'a', 100, first);
  assert.equal(rolling.endSeconds, 114);
  assert.equal(rolling.nextSequence, 3);
  assert.equal(rolling.availableStartSeconds, 103);
  // Older responses cannot move the cursor backward.
  assert.deepEqual(measuredHlsPreparedRange(manifest(0, [3]), 'a', 100, rolling), rolling);
});

test('a replacement generation or different seek start discards the earlier range', () => {
  const old = measuredHlsPreparedRange(manifest(0, [8, 8]), 'old', 0);
  const replaced = measuredHlsPreparedRange(manifest(0, [2]), 'new', 500, old);
  assert.equal(replaced.endSeconds, 502);
  assert.equal(replaced.generationId, 'new');
  assert.equal(measuredHlsPreparedRange(manifest(0, [3]), 'old', 300, old).endSeconds, 303);
});

test('unknown omitted durations and unsupported segment names are not estimated', () => {
  assert.equal(measuredHlsPreparedRange(manifest(7, [2, 2]), 'a', 0), null);
  assert.equal(measuredHlsPreparedRange('#EXTM3U\n#EXTINF:2,\nprovider.ts\n', 'a', 0), null);
});

test('prepared-range is a read-only VOD streaming endpoint', () => {
  const path = '/api/xtream/hls/provider/movie/42/prepared-range';
  assert.equal(isStreamingRoute('GET', path), true);
  assert.equal(isStreamingRoute('POST', path), false);
  assert.equal(isStreamingRoute('GET', path.replace('/movie/', '/channel/')), false);
});
