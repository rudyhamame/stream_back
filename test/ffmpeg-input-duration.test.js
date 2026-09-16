import test from 'node:test';
import assert from 'node:assert/strict';
import { inputDurationSeconds } from '../ffmpeg-input-duration.js';

test('reads full input duration rather than seek/output progress', () => {
  assert.equal(inputDurationSeconds('Input #0\n Duration: 01:23:45.50, start: 0\nOutput #0\ntime=00:00:01.00'), 5026);
  assert.equal(inputDurationSeconds('Duration: N/A\nOutput #0\nDuration: 00:01:00.00'), 0);
  assert.equal(inputDurationSeconds('time=00:03:00.00'), 0);
  assert.equal(inputDurationSeconds('Duration: 00:00:'), 0);
});
