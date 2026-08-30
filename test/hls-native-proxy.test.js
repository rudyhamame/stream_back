import test from 'node:test';
import assert from 'node:assert/strict';
import { hlsResourceId, isHlsManifest, rewriteHlsManifest } from '../hls-native-proxy.js';

test('rewrites variants, segments, encryption keys, and media URIs without exposing provider URLs', () => {
  const resources = new Map();
  const local = url => {
    const id = hlsResourceId(url);
    resources.set(id, url);
    return `/resource/${id}`;
  };
  const rewritten = rewriteHlsManifest([
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/live.key"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio/index.m3u8"',
    '#EXTINF:2.0,',
    'segments/one.ts?token=secret',
  ].join('\n'), 'https://provider.example/live/master.m3u8', local);
  assert.equal(rewritten.includes('provider.example'), false);
  assert.equal(rewritten.includes('token=secret'), false);
  assert.equal(resources.size, 3);
  assert.equal([...resources.values()].includes('https://provider.example/live/keys/live.key'), true);
  assert.equal([...resources.values()].includes('https://provider.example/live/audio/index.m3u8'), true);
  assert.equal([...resources.values()].includes('https://provider.example/live/segments/one.ts?token=secret'), true);
});

test('recognizes HLS from MIME type, URL, or manifest signature', () => {
  assert.equal(isHlsManifest('application/vnd.apple.mpegurl', 'https://x/live'), true);
  assert.equal(isHlsManifest('', 'https://x/live.m3u8?token=1'), true);
  assert.equal(isHlsManifest('text/plain', 'https://x/live', '#EXTM3U\n'), true);
  assert.equal(isHlsManifest('video/mp2t', 'https://x/segment.ts'), false);
});
