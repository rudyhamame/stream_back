import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { KeyedSerialExecutor, hlsSessionKey, hlsChildRequestQuery, isPlaybackSupersededForViewer, samePlaybackViewer } from '../media-session-policy.js';
import { HLS_MODE, selectEnabledHlsForMedia, selectEnabledHlsStrategy } from '../stream-strategy-selection.js';
import { PlaybackClient, HlsStrategy, getPlaybackCapabilities, hlsPlaylistProfile, hlsManifestStartupTimeoutMs, strategyUsesEncoding } from '../playback-strategy.js';

// Execute the real creation and manifest handlers without provider/database I/O.
const source = readFileSync(process.env.HLS_TEST_SERVER_PATH || new URL('../server.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function hlsStartSeconds('), source.indexOf('function providerProbeCacheKey('))
  + source.slice(source.indexOf('async function getOrStartRokuHls('), source.indexOf('// One centralized sweep'));
const route = source.slice(source.indexOf("app.get('/api/xtream/hls/:sourceId/:kind/:id/master.m3u8'"), source.indexOf("app.get('/api/xtream/hls/:sourceId/channel/:id/resource/:resourceId'"));

function harness(fullEnabled = true) {
  const jobs = new Map();
  const created = [], removed = [];
  const enabled = { HLS_AUDIO_TRANSCODE: true, HLS_FULL_TRANSCODE: fullEnabled };
  let handler;
  const context = {
    path, URL, AbortController, Date, process,
    playbackTraceId: () => 'test', ffprobeBin: 'ffprobe',
    console: { log() {}, warn() {} },
    app: { get: (_path, callback) => { handler = callback; } },
    getXtreamSource: async () => ({ _id: 'provider' }), requestAccountOwner: () => 'account',
    resolveStreamTicket: () => null, requestStreamTicket: () => '',
    playbackTarget: () => ({ client: 'roku', key: 'roku', capabilities: getPlaybackCapabilities('roku') }),
    mediaIdentity: () => ({ userId: 'account', viewerId: 'roku-1', deviceId: 'roku-1', client: 'roku' }),
    requestedHlsFallback: req => req.query.hlsFallback || '',
    getStreamStrategyPolicy: async () => ({ devices: { roku: enabled } }),
    mediaSourceLocks: new KeyedSerialExecutor(),
    mediaJobs: {
      get: key => jobs.get(key), entries: () => jobs.entries(),
      touch() {},
      remove: async key => { removed.push(key); jobs.delete(key); },
      releaseViewer: async key => { removed.push(key); jobs.delete(key); },
      getOrCreate: async fields => {
        const job = { ...fields, generationId: `generation-${created.length}`, child: { exitCode: null },
          directory: '/test', manifest: '/test/master.m3u8', error: '', finished: false };
        jobs.set(fields.key, job); created.push(job); return { job };
      },
    },
    fs: { access: async () => { throw new Error('no VAAPI'); },
      readFile: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment-000000.ts\n#EXTINF:2,\nsegment-000001.ts\n#EXTINF:2,\nsegment-000002.ts\n' },
    PlaybackClient, HlsStrategy, HLS_MODE, getPlaybackCapabilities, selectEnabledHlsForMedia, selectEnabledHlsStrategy,
    hlsPlaylistProfile, hlsManifestStartupTimeoutMs, strategyUsesEncoding,
    rokuHlsKey: hlsSessionKey, hlsChildRequestQuery, samePlaybackViewer, isPlaybackSupersededForViewer,
    hlsGenerationJobs: new Map(), codecProbeCache: new Map(),
    evictCodecProbeCache() {}, providerProbeCacheKey: () => 'probe',
    sourceProviderUrl: async () => 'https://provider.invalid/item.mkv',
    providerCodecMetadata: async () => ({ videoCodec: 'h264', videoProfile: 'Main', videoLevel: 31,
      pixelFormat: 'yuv420p', width: 1280, height: 720, frameRate: '25/1',
      audioCodec: 'aac', audioSampleRate: 32000, audioChannels: 2 }),
    playbackSourceHash: () => 'hash', reconcileWwpSession() {},
    waitForHlsManifest: async () => true,
    runCodecScan: async () => ({ videoCodec: 'h264', audioVideoStartDelta: 0.599 }),
    copiedVideoNeedsNormalization: () => true, isProviderRefusal: () => false,
    capacityResponse: () => false, hasHlsVariants: () => false,
    measureLocalHlsPlaylistBitrate: async () => null, DEFAULT_ROKU_FALLBACK_BITRATE: 1000000,
    rokuSingleVariantMaster: uri => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n${uri}\n`,
  };
  vm.runInNewContext(functions + route, context);
  async function manifest(start = 242.7, media = '1', hlsFallback = 'audio') {
    const query = { ext: 'mkv', client: 'roku', start: String(start), media, hlsFallback };
    const req = { params: { sourceId: 'provider', kind: 'series', id: '151274' }, query,
      originalUrl: `/api/xtream/hls/provider/series/151274/master.m3u8?${new URLSearchParams(query)}` };
    const res = { headers: {}, once() {}, off() {}, setHeader(k, v) { this.headers[k] = v; },
      send(body) { this.body = body; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await handler(req, res);
    return res;
  }
  return { manifest, jobs, created, removed, enabled, context };
}

test('post-seek audio-to-full fallback survives master/media refreshes at the same offset', async () => {
  const h = harness();
  assert.match((await h.manifest(242.7, '0')).body, /EXT-X-STREAM-INF/);
  assert.equal(h.created.length, 2);
  const full = h.created[1];
  assert.equal(full.hlsStrategy, 'HLS_FULL_TRANSCODE');
  assert.equal(full.key, h.created[0].key);
  for (let i = 0; i < 5; i++) {
    const res = await h.manifest();
    assert.equal(res.headers['X-RH-Strategy'], 'HLS_FULL_TRANSCODE');
    assert.match(res.body, new RegExp(`generation=${full.generationId}`));
    assert.equal(h.jobs.get(full.key), full);
  }
  assert.equal(h.created.length, 2);
  assert.equal(h.removed.length, 1);
  await h.manifest(300);
  assert.equal(h.created.length, 4);
  assert.notEqual(h.created[3].key, full.key);
  assert.equal(h.created[3].startSeconds, 300);
});

test('fallback reuse still rejects a strategy unchecked after startup', async () => {
  const h = harness();
  await h.manifest();
  h.enabled.HLS_FULL_TRANSCODE = false;
  const res = await h.manifest();
  assert.equal(res.code, 502);
  assert.match(res.body.error, /no longer checked/);
  assert.equal(h.created.length, 2);
});

test('unsafe post-seek audio never starts an unchecked full transcode', async () => {
  const h = harness(false);
  const res = await h.manifest();
  assert.equal(res.code, 504);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].hlsStrategy, 'HLS_AUDIO_TRANSCODE');
});
