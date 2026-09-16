import test from 'node:test';
import assert from 'node:assert/strict';
import { hlsPlaylistProfile } from '../playback-strategy.js';

test('live previews can start from the first remuxed segment', () => {
  assert.equal(hlsPlaylistProfile({ preview: true }).startupSegments, 1);
  assert.equal(hlsPlaylistProfile().startupSegments, 3);
  assert.equal(hlsPlaylistProfile({ preview: true }).segmentSeconds, 2);
});
