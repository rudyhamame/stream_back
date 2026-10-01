import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXtreamChannelsPayload, directXtreamItem, rokuXtreamPlaybackPath, rokuXtreamStreamFormat } from '../roku-media-format.js';

test('Roku stream formats preserve Direct-compatible containers', () => {
  assert.equal(rokuXtreamStreamFormat('.mkv'), 'mkv');
  assert.equal(rokuXtreamStreamFormat('mov'), 'mp4');
  assert.equal(rokuXtreamStreamFormat('ts'), 'hls');
});

test('Roku playback paths keep VOD Direct and channels on HLS', () => {
  assert.equal(rokuXtreamPlaybackPath('source one', 'movie', '42', 'mp4'), '/api/xtream/play/source%20one/movie/42?ext=mp4');
  assert.equal(rokuXtreamPlaybackPath('source one', 'channel', '42', 'mp4'), '/api/xtream/hls/source%20one/channel/42/master.m3u8?ext=mp4');
});

test('Roku media payloads retain identity and display formatting', () => {
  const item = { sourceId: 's1', kind: 'movie', id: '7', extension: 'mkv', title: 'Title' };
  const result = directXtreamItem(item, value => `formatted:${value}`);
  assert.equal(result.favoriteId, 'xtream:s1:movie:7');
  assert.equal(result.rokuTitle, 'formatted:Title');
  assert.equal(result.streamFormat, 'mkv');

  const [channel] = buildXtreamChannelsPayload([{ ...item, kind: 'channel', sourceName: 'Provider', category: '' }], value => `formatted:${value}`);
  assert.equal(channel.group, 'Provider');
  assert.equal(channel.rokuGroup, 'formatted:Provider');
});
