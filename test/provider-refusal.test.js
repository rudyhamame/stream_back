import test from 'node:test';
import assert from 'node:assert/strict';
import { isProviderRefusal } from '../provider-refusal.js';

test('FFmpeg progress and media metadata never masquerade as provider refusal', () => {
  for (const text of [
    'frame=403\nfps=24.5\nbitrate=429.1kbits/s\nout_time=00:00:13.404000\nprogress=continue',
    'Duration: 01:31:23.451, start: 0.000000, bitrate: 401 kb/s',
    '[hls] Opening segment-000404.ts for writing',
    'Decoder not found', 'Option not found', '',
  ]) assert.equal(isProviderRefusal(text), false, text);
});

test('explicit upstream rejection still stops wasteful transcoding retries', () => {
  for (const text of [
    '[http] HTTP error 403 Forbidden', 'Server returned 404 Not Found',
    'HTTP 429 Too Many Requests', 'HTTP status code: 401',
    'Access denied', 'Connection limit exceeded',
  ]) assert.equal(isProviderRefusal(text), true, text);
});
