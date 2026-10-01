import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeHlsSessionCache } from '../native-hls-session-cache.js';

const request = { params: { sourceId: 'source-1', id: 'channel-2' }, query: { ext: 'm3u8' } };

test('native HLS session cache retains viewer state and rejects a different user', () => {
  const cache = createNativeHlsSessionCache();
  const first = cache.get(request, { userId: 'account-a', viewerId: 'device-a' }, true);
  assert.equal(cache.get(request, { userId: 'account-a', viewerId: 'device-b' }), first);
  assert.deepEqual([...first.viewers], ['device-a', 'device-b']);
  assert.equal(cache.get(request, { userId: 'account-b', viewerId: 'device-c' }), null);
  assert.deepEqual([...first.viewers], ['device-a', 'device-b']);
});

test('native HLS session cache removes expired entries', () => {
  const cache = createNativeHlsSessionCache();
  const session = cache.get(request, { userId: 'account-a', viewerId: 'device-a' }, true);
  cache.evict(session.expiresAt + 1);
  assert.equal(cache.sessions.size, 0);
});
