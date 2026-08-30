import test from 'node:test';
import assert from 'node:assert/strict';
import { previewFrameSize } from '../preview-capture-policy.js';

test('uses JPEG-safe even dimensions for cards and full-player seek frames', () => {
  for (const size of [previewFrameSize(), previewFrameSize({ playerFrame: true })]) {
    assert.equal(size.width % 2, 0);
    assert.equal(size.height % 2, 0);
  }
  assert.deepEqual(previewFrameSize(), { width: 520, height: 292 });
  assert.deepEqual(previewFrameSize({ playerFrame: true }), { width: 1280, height: 720 });
});
