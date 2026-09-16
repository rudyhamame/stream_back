import test from 'node:test';
import assert from 'node:assert/strict';
import { previewFrameSize, previewInputArgs, seekPreviewPosition } from '../preview-capture-policy.js';

test('uses JPEG-safe even dimensions for Live TV cards', () => {
  const size = previewFrameSize();
  assert.equal(size.width % 2, 0);
  assert.equal(size.height % 2, 0);
  assert.deepEqual(size, { width: 520, height: 292 });
});

test('clamps VOD seek previews to a safe whole-second position', () => {
  assert.equal(seekPreviewPosition('-20', 100), 0);
  assert.equal(seekPreviewPosition('42.6', 100), 43);
  assert.equal(seekPreviewPosition('100', 100), 98);
  assert.equal(seekPreviewPosition('not-a-number', 100), 0);
});

test('seeks before opening VOD input but leaves live captures at the head', () => {
  assert.deepEqual(previewInputArgs('movie', 42.6), ['-ss', '43']);
  assert.deepEqual(previewInputArgs('series', 9), ['-ss', '9']);
  assert.deepEqual(previewInputArgs('channel', 9), []);
});
