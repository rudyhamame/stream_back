import test from 'node:test';
import assert from 'node:assert/strict';
import { previewFrameSize } from '../preview-capture-policy.js';

test('uses JPEG-safe even dimensions for Live TV cards', () => {
  const size = previewFrameSize();
  assert.equal(size.width % 2, 0);
  assert.equal(size.height % 2, 0);
  assert.deepEqual(size, { width: 520, height: 292 });
});
