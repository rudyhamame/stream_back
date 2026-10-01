import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeProbe, inspectProviderCodecs, runCodecScan, mergeProbeFacts, missingProbeFacts, probeCacheTtl } from '../codec-probe.js';
import { codecCompatibility, confidentDirectPlayback, getPlaybackCapabilities } from '../playback-strategy.js';
import { selectEnabledHlsForMedia } from '../stream-strategy-selection.js';
import { probeLiveSegment } from '../live-hls-compatibility.js';

const video = { index: 1, codec_type: 'video', codec_name: 'h264', profile: 'High', level: 31, pix_fmt: 'yuv420p', width: 1280, height: 720, avg_frame_rate: '25/1' };
const audio = { index: 2, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' };
const complete = normalizeProbe({ streams: [video, audio], format: { format_name: 'mov,mp4', duration: '90' } });
const scanSequence = values => {
  const calls = [];
  const scan = async (url, options) => {
    calls.push(options);
    const value = values.shift();
    if (value instanceof Error) throw value;
    return value;
  };
  return { scan, calls };
};

test('complete results use one scan; incomplete results use exactly one deeper scan', async () => {
  const ready = scanSequence([complete]);
  assert.deepEqual(await inspectProviderCodecs('input', ready), complete);
  assert.equal(ready.calls.length, 1);
  const partial = scanSequence([{ videoCodec: 'h264' }, complete]);
  assert.deepEqual(await inspectProviderCodecs('input', partial), complete);
  assert.equal(partial.calls.length, 2);
  assert.equal(partial.calls[1].deep, true);
});

test('deep scan failures preserve initial codec facts and do not throw from logging', async () => {
  const partial = { videoCodec: 'h264', audioCodec: 'aac' };
  assert.deepEqual(await inspectProviderCodecs('input', scanSequence([partial, new Error('timeout')])), partial);
  const incompleteDeep = { ...partial, width: 1280 };
  assert.deepEqual(await inspectProviderCodecs('input', scanSequence([{}, incompleteDeep])), incompleteDeep);
});

test('transient initial failures retry once; explicit provider refusals stop', async () => {
  assert.deepEqual(await inspectProviderCodecs('input', scanSequence([new Error('timeout'), complete])), complete);
  const refused = scanSequence([new Error('HTTP error 403 Forbidden')]);
  await assert.rejects(inspectProviderCodecs('input', refused), /403/);
  assert.equal(refused.calls.length, 1);
  await assert.rejects(inspectProviderCodecs('input', scanSequence([{}, new Error('HTTP error 429')])), /429/);
});

test('partial cache entries expire quickly while complete results keep configured TTL', () => {
  assert.equal(probeCacheTtl(complete, 21600000), 21600000);
  assert.equal(probeCacheTtl({ videoCodec: 'h264' }, 21600000), 5000);
  assert.equal(probeCacheTtl({ ...complete, videoProfile: 'unknown' }, 21600000), 5000);
});

test('deeper scans fill missing facts and merge tracks by actual stream index', () => {
  const first = { ...complete, audioTracks: [{ index: 2, codec: 'aac', channels: 2 }] };
  const next = { videoCodec: '', width: 0, audioTracks: [{ index: 3, codec: 'ac3' }, { index: 2, codec: '', sampleRate: 48000 }] };
  const merged = mergeProbeFacts(first, next);
  assert.equal(merged.videoCodec, 'h264');
  assert.equal(merged.width, 1280);
  assert.deepEqual(merged.audioTracks, [{ index: 2, codec: 'aac', channels: 2, sampleRate: 48000 }, { index: 3, codec: 'ac3' }]);
});

test('normalization ignores artwork and rejects unknown, negative level and invalid frame rates', () => {
  const metadata = normalizeProbe({ streams: [
    { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
    { ...video, level: -99, profile: 'unknown', pix_fmt: 'unknown', avg_frame_rate: '0/0', r_frame_rate: '30/1' }, audio,
  ] });
  assert.equal(metadata.videoCodec, 'h264');
  assert.equal(metadata.videoLevel, 0);
  assert.equal(metadata.videoProfile, '');
  assert.equal(metadata.frameRate, '30');
  assert.ok(missingProbeFacts(metadata).includes('pixelFormat'));
  assert.equal(normalizeProbe({ streams: [{ codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }] }).videoCodec, '');
});

test('a detected audio stream without codec remains unknown; it is not silent media', () => {
  const metadata = normalizeProbe({ streams: [video, { codec_type: 'audio' }] });
  assert.ok(missingProbeFacts(metadata).includes('audioCodec'));
  assert.equal(codecCompatibility(metadata).known, false);
  assert.equal(confidentDirectPlayback({ ...complete, videoLevel: -99 }, getPlaybackCapabilities(), 'mp4').compatible, false);
  const enabled = { HLS_REMUX: true, HLS_FULL_TRANSCODE: true };
  assert.equal(selectEnabledHlsForMedia({}, getPlaybackCapabilities(), enabled).strategy, 'HLS_REMUX');
  assert.equal(selectEnabledHlsForMedia({}, getPlaybackCapabilities(), { HLS_FULL_TRANSCODE: true }), null);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = 0;
  child.kill = () => { child.kills++; };
  return child;
}

test('scan timeout kills and settles even when the process never emits close', async () => {
  const child = fakeChild();
  await assert.rejects(runCodecScan('input', { spawnProcess: () => child, timeoutMs: 10 }), /timed out/);
  assert.equal(child.kills, 1);
});

test('invalid JSON, process errors, and oversized output all settle safely', async () => {
  for (const failure of ['json', 'spawn', 'large']) {
    const child = fakeChild();
    const result = runCodecScan('input', { spawnProcess: () => child });
    if (failure === 'spawn') child.emit('error', new Error('ENOENT'));
    else {
      child.stdout.emit('data', failure === 'large' ? 'x'.repeat(1024 * 1024 + 1) : '{broken');
      child.emit('close', 0);
    }
    await assert.rejects(result);
  }
});

test('completed initial scan clears its timer before the deeper scan continues', async () => {
  const children = [];
  const spawnProcess = () => { const child = fakeChild(); children.push(child); return child; };
  const scan = (url, options) => runCodecScan(url, { ...options, spawnProcess, timeoutMs: options.deep ? 150 : 10 });
  const result = inspectProviderCodecs('input', { scan });
  children[0].stdout.emit('data', JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264' }] }));
  children[0].emit('close', 0);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(children[0].kills, 0);
  children[1].stdout.emit('data', JSON.stringify({ streams: [video, audio], format: { format_name: 'mov,mp4' } }));
  children[1].emit('close', 0);
  assert.equal((await result).audioCodec, 'aac');
});

test('real VOD and already-fetched Live bytes share normalized codec facts', async t => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
  catch { t.skip('FFmpeg unavailable'); return; }
  const dir = await mkdtemp(path.join(tmpdir(), 'rh-codecs-'));
  try {
    const filename = path.join(dir, 'sample.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-profile:v', 'high', '-c:a', 'aac', '-ac', '2', filename]);
    const vod = await inspectProviderCodecs(filename);
    assert.equal(vod.videoCodec, 'h264');
    assert.equal(vod.audioCodec, 'aac');
    assert.equal(missingProbeFacts(vod).length, 0);
    const bytes = execFileSync('ffmpeg', ['-v', 'error', '-i', filename, '-c', 'copy', '-f', 'mpegts', 'pipe:1']);
    const live = await probeLiveSegment(bytes);
    for (const field of ['videoCodec', 'audioCodec', 'audioSampleRate', 'audioChannels', 'width', 'height', 'frameRate']) assert.equal(live[field], vod[field], field);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('video-only initial scans must check deeper before treating missing audio as absent', async () => {
  const shallow = normalizeProbe({ streams: [video], format: { format_name: 'mp4' } });
  assert.equal(shallow.audioStreamStatus, 'unknown');
  assert.equal(codecCompatibility(shallow).known, false);
  assert.ok(missingProbeFacts(shallow).includes('audioCodec'));
  const delayedAudio = scanSequence([shallow, complete]);
  assert.equal((await inspectProviderCodecs('input', delayedAudio)).audioCodec, 'aac');
  assert.equal(delayedAudio.calls.length, 2);
  const silent = normalizeProbe({ streams: [video], format: { format_name: 'mp4' } }, { deep: true });
  assert.equal(silent.audioStreamStatus, 'absent');
  assert.equal(missingProbeFacts(silent).length, 0);
  assert.equal(codecCompatibility(silent).known, true);
  const retained = mergeProbeFacts(complete, silent);
  assert.equal(retained.audioStreamStatus, 'present');
  assert.equal(retained.audioCodec, 'aac');
});
