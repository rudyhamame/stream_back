import test from 'node:test';
import assert from 'node:assert/strict';
import { isStreamingRoute } from '../streaming-route-policy.js';

test('allows only health and media delivery GET surfaces', () => {
  const allowed = [
    '/api/health',
    '/api/roku/auth-health?deviceToken=redacted',
    '/api/playback/preview?sourceId=source-1&kind=channel&id=42',
    '/internal/media-health',
    '/api/xtream/play/source-1/channel/42',
    '/api/xtream/hls/source-1/movie/42/master.m3u8',
    '/api/xtream/hls/source-1/series/episode-3/segment-000001.ts',
    '/api/xtream/hls/source-1/channel/42/resource/0123456789abcdef01234567',
  ];
  for (const path of allowed) assert.equal(isStreamingRoute('GET', path), true, path);
});

test('blocks all control-plane and data-management routes', () => {
  const blocked = [
    '/api/account/login',
    '/api/account/devices',
    '/api/roku/bootstrap',
    '/api/roku/channels',
    '/api/roku/series',
    '/api/roku/movies',
    '/api/roku/device-session',
    '/api/roku/heartbeat',
    '/api/roku/dashboard',
    '/api/playback/history',
    '/api/playback',
    '/api/favorites',
    '/api/library/categories',
    '/api/xtream/sources',
    '/api/xtream/catalog',
    '/api/xtream/logo',
  ];
  for (const path of blocked) assert.equal(isStreamingRoute('GET', path), false, path);
});

test('blocks mutations even when the path resembles streaming', () => {
  assert.equal(isStreamingRoute('POST', '/api/xtream/play/source/channel/42'), false);
  assert.equal(isStreamingRoute('PUT', '/api/xtream/hls/source/movie/42/master.m3u8'), false);
  assert.equal(isStreamingRoute('DELETE', '/api/health'), false);
});

test('rejects prefix and traversal lookalikes', () => {
  assert.equal(isStreamingRoute('GET', '/api/xtream/play/source/channel/42/extra'), false);
  assert.equal(isStreamingRoute('GET', '/api/xtream/hls/source/channel/42/not-a-segment.ts'), false);
  assert.equal(isStreamingRoute('GET', '/api/xtream/hls/source/channel/42/resource/not-a-valid-id'), false);
  assert.equal(isStreamingRoute('GET', '/api/xtream/sources/../play/source/channel/42'), false);
});
