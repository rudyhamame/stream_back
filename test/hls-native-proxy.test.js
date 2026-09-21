import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ROKU_FALLBACK_BITRATE, HlsBitrateSource, HlsPlaylistType, classifyHlsPlaylist, createHlsSegmentBitrateSample, hasHlsVariants, hlsResourceId, isHlsManifest, measuredHlsBitrateMetadata, normalizeHlsMasterForRoku, parseHlsMediaSegments, providerMasterBitrateMetadata, rewriteHlsManifest, rokuSingleVariantMaster } from '../hls-native-proxy.js';

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

test('uses an explicitly identified last-resort fallback for malformed and single-variant playlists', () => {
  const malformed = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=0,CODECS="avc1.4d401f"\nvideo.m3u8\n';
  const normalized = normalizeHlsMasterForRoku(malformed);
  assert.match(normalized, /BANDWIDTH=2500000/);
  assert.equal(DEFAULT_ROKU_FALLBACK_BITRATE.bitrateSource, HlsBitrateSource.FALLBACK);
  assert.equal(DEFAULT_ROKU_FALLBACK_BITRATE.reason, 'no_provider_probe_or_segment_measurement');
  assert.equal(hasHlsVariants(normalized), true);
  const wrapped = rokuSingleVariantMaster('/resource/abc');
  assert.match(wrapped, /#EXT-X-STREAM-INF:BANDWIDTH=2500000,AVERAGE-BANDWIDTH=2000000/);
  assert.equal(wrapped.includes('/resource/abc'), true);
  assert.equal(hasHlsVariants('#EXTM3U\n#EXTINF:2,\none.ts\n'), false);
});

test('classifies provider master, media, and invalid playlists explicitly', () => {
  assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo.m3u8\n'), HlsPlaylistType.MASTER);
  assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXTINF:2.88,\nsegment.ts\n'), HlsPlaylistType.MEDIA);
  assert.equal(classifyHlsPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:3\n'), HlsPlaylistType.UNKNOWN);
  assert.equal(classifyHlsPlaylist('not hls'), HlsPlaylistType.UNKNOWN);
});

test('preserves valid provider BANDWIDTH and AVERAGE-BANDWIDTH metadata', () => {
  const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,AVERAGE-BANDWIDTH=5200000\nvideo.m3u8\n';
  assert.deepEqual(providerMasterBitrateMetadata(manifest), {
    bandwidth: 6000000,
    averageBandwidth: 5200000,
    bitrateSource: HlsBitrateSource.PROVIDER,
    sampleCount: 0,
  });
  assert.equal(normalizeHlsMasterForRoku(manifest), manifest);
});

test('does not invent AVERAGE-BANDWIDTH when a provider supplies only valid BANDWIDTH', () => {
  const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6500000\nvideo.m3u8\n';
  assert.equal(normalizeHlsMasterForRoku(manifest), manifest);
  assert.equal(providerMasterBitrateMetadata(manifest).averageBandwidth, null);
});

test('parses EXTINF durations and resolves tokenized segments against the final playlist URL', () => {
  const manifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:3942\n#EXTINF:2.88,\n/hls/155491/3942.ts?token=secret\n#EXTINF:3.12,\nnext.ts?token=next\n';
  const segments = parseHlsMediaSegments(manifest, 'http://212.1.2.3:8080/hls/155491/index.m3u8?token=playlist');
  assert.deepEqual(segments, [
    { sequence: 3942, durationSec: 2.88, url: 'http://212.1.2.3:8080/hls/155491/3942.ts?token=secret' },
    { sequence: 3943, durationSec: 3.12, url: 'http://212.1.2.3:8080/hls/155491/next.ts?token=next' },
  ]);
});

test('calculates weighted average and peak-plus-safety BANDWIDTH from multiple segments', () => {
  const first = createHlsSegmentBitrateSample({ sequence: 1, durationSec: 2, url: 'one.ts' }, Buffer.alloc(1_000_000));
  const second = createHlsSegmentBitrateSample({ sequence: 2, durationSec: 4, url: 'two.ts' }, Buffer.alloc(2_000_000));
  const measured = measuredHlsBitrateMetadata([first, second], 1.10);
  assert.equal(measured.averageBandwidth, 4_000_000);
  assert.equal(measured.measuredPeakSegmentBandwidth, 4_000_000);
  assert.equal(measured.bandwidth, 4_400_000);
  assert.equal(measured.bitrateSource, HlsBitrateSource.MEASURED_SEGMENTS);
  assert.equal(measured.sampleCount, 2);
});

test('keeps variable-rate average separate from the conservative peak requirement', () => {
  const samples = [
    createHlsSegmentBitrateSample({ sequence: 1, durationSec: 2 }, 1_000_000),
    createHlsSegmentBitrateSample({ sequence: 2, durationSec: 4 }, 3_000_000),
  ];
  const measured = measuredHlsBitrateMetadata(samples, 1.10);
  assert.equal(measured.averageBandwidth, 5_333_333);
  assert.equal(measured.measuredPeakSegmentBandwidth, 6_000_000);
  assert.equal(measured.bandwidth, 6_600_000);
  assert.notEqual(measured.bandwidth, measured.averageBandwidth);
});

test('counts actual received bytes without requiring Content-Length', () => {
  const sample = createHlsSegmentBitrateSample({ sequence: 3948, durationSec: 3 }, Buffer.alloc(1_850_000));
  assert.equal(sample.sizeBytes, 1_850_000);
  assert.equal(sample.bitrateBps, 4_933_333);
});

test('rejects malformed provider metadata instead of treating it as provider truth', () => {
  for (const value of ['0', '-1', 'NaN', 'Infinity', 'garbage', '']) {
    const manifest = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${value}\nvideo.m3u8\n`;
    assert.equal(providerMasterBitrateMetadata(manifest), null);
    assert.match(normalizeHlsMasterForRoku(manifest), /BANDWIDTH=2500000/);
  }
});

test('bitrate measurement remains metadata-only and cannot select transcoding', () => {
  const measured = measuredHlsBitrateMetadata([
    createHlsSegmentBitrateSample({ sequence: 1, durationSec: 2 }, 1_000_000),
    createHlsSegmentBitrateSample({ sequence: 2, durationSec: 2 }, 1_100_000),
  ]);
  assert.equal(Object.hasOwn(measured, 'videoMode'), false);
  assert.equal(Object.hasOwn(measured, 'audioMode'), false);
  assert.equal(Object.hasOwn(measured, 'strategy'), false);
});
