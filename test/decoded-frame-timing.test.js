import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDecodedPts, normalizeFrameRate, setptsForFrameRate } from '../decoded-frame-timing.js';

const frames = values => values.map(pts_time => ({ pts_time: String(pts_time) }));

test('decoded PTS detector accepts healthy display order and B-frame-compatible timing', () => {
  assert.equal(inspectDecodedPts(frames([0, 0.042, 0.083, 0.125, 0.167])).timingMalformed, false);
});

test('decoded PTS detector catches meaningful regressions in the decoded frame sequence', () => {
  assert.equal(inspectDecodedPts(frames([0, 0.125, 0.083, 0.166, 0.041])).timingMalformed, true);
  const observed = inspectDecodedPts(frames([0.791, 0.750, 0.833, 0.708]));
  assert.equal(observed.timingMalformed, true);
  assert.equal(observed.regressionCount, 2);
  assert.equal(observed.largestRegressionSeconds, 0.125);
});

test('decoded PTS detector ignores sub-millisecond floating-point noise', () => {
  assert.equal(inspectDecodedPts(frames([1, 0.9999998, 1.041667])).timingMalformed, false);
});

test('decoded PTS detector skips missing PTS and uses best-effort timestamps', () => {
  const result = inspectDecodedPts([
    { pts_time: null, best_effort_timestamp_time: '0.000' },
    { pts_time: null, best_effort_timestamp_time: '0.042' },
    { pts_time: null, best_effort_timestamp_time: '0.083' },
  ]);
  assert.equal(result.framesChecked, 3);
  assert.equal(result.timingMalformed, false);
  assert.equal(inspectDecodedPts([{ pts_time: null }, {}]).framesChecked, 0);
  assert.equal(inspectDecodedPts([]).decodedPtsMonotonic, null);
});

test('frame-rate rebuild uses exact supported rational rates', () => {
  for (const rate of ['24/1', '25/1', '24000/1001', '30000/1001', '50/1', '60000/1001']) {
    assert.equal(normalizeFrameRate(rate), rate);
    assert.equal(setptsForFrameRate(rate), `setpts=N/((${rate})*TB)`);
  }
  assert.equal(setptsForFrameRate('0/0'), '');
});
