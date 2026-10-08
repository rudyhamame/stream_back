import test from 'node:test';
import assert from 'node:assert/strict';
import { createHlsPreparedRangeReader } from '../hls-prepared-range-reader.js';

const manifest = (sequence, durations, extension = 'ts') => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:' + sequence + '\n' + durations.map((seconds, index) =>
  `#EXTINF:${seconds},\nsegment-${String(sequence + index).padStart(6, '0')}.${extension}\n`).join('');
const job = (generationId = 'a') => ({ generationId, manifest: `/hls/${generationId}/index.m3u8`, directory: `/hls/${generationId}`, startSeconds: 100 });

test('concurrent transport and housekeeping reads share I/O without caching the next poll', async () => {
  let reads = 0;
  let checks = 0;
  let text = manifest(0, [2, 3]);
  const read = createHlsPreparedRangeReader({
    readFile: async () => { reads++; return text; },
    access: async () => { checks++; },
  });
  const generation = job();
  const first = read(generation);
  assert.equal(read(generation), first);
  const range = await first;
  assert.equal(range.endSeconds, 105);
  assert.equal(reads, 1);
  assert.equal(checks, 1);
  text = manifest(1, [3, 4]);
  assert.equal((await read(generation)).endSeconds, 109);
  assert.equal(generation.preparedTimeline.availableStartSeconds, 102);
  assert.equal(reads, 2);
});

test('generation jobs keep separate manifests, absolute ranges and segment formats', async () => {
  const paths = [];
  const read = createHlsPreparedRangeReader({
    readFile: async file => manifest(0, [file.includes('/a/') ? 2 : 7], file.includes('/a/') ? 'ts' : 'm4s'),
    access: async file => { paths.push(file); },
  });
  const a = job('a');
  const b = { ...job('b'), startSeconds: 500, hlsSegmentType: 'fmp4' };
  const [rangeA, rangeB] = await Promise.all([read(a), read(b)]);
  assert.equal(rangeA.endSeconds, 102);
  assert.equal(rangeB.endSeconds, 507);
  assert.deepEqual(paths.sort(), ['/hls/a/segment-000000.ts', '/hls/b/segment-000000.m4s']);
});

test('missing completed segment does not advance the cursor and can recover later', async () => {
  let missing = true;
  const read = createHlsPreparedRangeReader({
    readFile: async () => manifest(0, [8]),
    access: async () => { if (missing) throw new Error('ENOENT'); },
  });
  const generation = job();
  assert.equal(await read(generation), null);
  assert.equal(generation.preparedTimeline, undefined);
  missing = false;
  assert.equal((await read(generation)).endSeconds, 108);
});

test('older manifests cannot move a completed range backward', async () => {
  let text = manifest(0, [4, 4]);
  const read = createHlsPreparedRangeReader({ readFile: async () => text, access: async () => {} });
  const generation = job();
  const latest = await read(generation);
  text = manifest(0, [4]);
  assert.deepEqual(await read(generation), latest);
  assert.equal(await read(null), null);
});
