import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectStreamLimiter } from '../direct-stream-limiter.js';

test('limits direct provider connections globally and per source', () => {
  const limiter = new DirectStreamLimiter({ maxTotal: 3, maxPerSource: 2 });
  const releaseA1 = limiter.acquire('source-a');
  const releaseA2 = limiter.acquire('source-a');
  assert.throws(() => limiter.acquire('source-a'), /provider direct-stream capacity/i);
  const releaseB = limiter.acquire('source-b');
  assert.throws(() => limiter.acquire('source-c'), /direct-stream capacity/i);
  assert.equal(limiter.activeCount, 3);
  releaseA1();
  releaseA1();
  const releaseC = limiter.acquire('source-c');
  assert.equal(limiter.activeCount, 3);
  releaseA2();
  releaseB();
  releaseC();
  assert.equal(limiter.activeCount, 0);
});
