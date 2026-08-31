import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createBif, runFfmpeg, TrickPlayManager, validateBif } from '../trickplay-manager.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]);

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-trickplay-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('creates and validates a Roku BIF v0 archive atomically usable by the cache', async t => {
  const root = await temporaryDirectory(t);
  const frames = [];
  for (let index = 0; index < 3; index += 1) {
    const file = path.join(root, `${String(index).padStart(8, '0')}.jpg`);
    await fs.writeFile(file, JPEG);
    frames.push(file);
  }
  const output = path.join(root, 'preview.bif');
  await createBif(frames, output, 10);
  const result = await validateBif(output);
  assert.deepEqual(result, { thumbnailCount: 3, intervalMilliseconds: 10_000, bytes: 120 });
});

test('deduplicates simultaneous viewers and reuses the ready asset', async t => {
  const root = await temporaryDirectory(t);
  let runs = 0;
  const runner = async ({ framePattern }) => {
    runs += 1;
    await fs.writeFile(framePattern.replace('%08d', '00000000'), JPEG);
    await fs.writeFile(framePattern.replace('%08d', '00000001'), JPEG);
  };
  const manager = new TrickPlayManager({ root, runner, canRun: () => true });
  const spec = { sourceId: 'source-1', contentType: 'movie', contentId: '42', duration: 120, extension: 'mp4', inputUrl: 'https://provider.invalid/movie' };
  await Promise.all([manager.ensure(spec), manager.ensure(spec), manager.ensure(spec)]);
  await Promise.all(manager.active.values());
  assert.equal(runs, 1);
  assert.equal((await manager.readyFile(spec)).status, 'ready');
  await manager.ensure(spec);
  assert.equal(runs, 1);
});

test('queues while playback has priority and never generates live or unknown-duration content', async t => {
  const root = await temporaryDirectory(t);
  let playbackActive = true;
  let runs = 0;
  const manager = new TrickPlayManager({
    root, canRun: () => !playbackActive,
    runner: async ({ framePattern }) => { runs += 1; await fs.writeFile(framePattern.replace('%08d', '00000000'), JPEG); },
  });
  const spec = { sourceId: 'source-1', contentType: 'episode', contentId: '7', duration: 60, inputUrl: 'https://provider.invalid/episode' };
  assert.equal((await manager.ensure({ ...spec, duration: 0 })).reason, 'duration-unavailable');
  await manager.ensure(spec);
  assert.equal(runs, 0);
  playbackActive = false;
  await manager.drain();
  await Promise.all(manager.active.values());
  assert.equal(runs, 1);
  await assert.rejects(() => manager.ensure({ ...spec, contentType: 'channel' }), /Invalid contentType/);
});

test('focused catalog item moves to the front of the cold preview queue', async t => {
  const root = await temporaryDirectory(t);
  const manager = new TrickPlayManager({ root, canRun: () => false });
  const first = { sourceId: 'source-1', contentType: 'episode', contentId: 'first', duration: 60, inputUrl: 'https://provider.invalid/first' };
  const focused = { sourceId: 'source-1', contentType: 'episode', contentId: 'focused', duration: 60, inputUrl: 'https://provider.invalid/focused' };
  await manager.ensure(first);
  await manager.ensure(focused);
  await manager.ensure({ ...focused, priority: 'focused' });
  assert.equal(manager.queue[0].paths.contentId, 'focused');
  assert.equal(manager.queue.length, 2);
});

test('FFmpeg preemption settles only after the provider process closes', async () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  let closed = false;
  child.kill = () => {
    setTimeout(() => {
      closed = true;
      child.emit('close', null);
    }, 30);
    return true;
  };
  const controller = new AbortController();
  let settled = false;
  const running = runFfmpeg({
    inputUrl: 'https://provider.invalid/episode', framePattern: '/tmp/%08d.jpg',
    intervalSeconds: 10, width: 320, height: 180, timeoutMs: 1_000,
    signal: controller.signal, spawnProcess: () => child,
  });
  const observed = running.finally(() => { settled = true; });
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(settled, false);
  await assert.rejects(observed, error => error.name === 'AbortError');
  assert.equal(closed, true);
});

test('generation failure leaves playback-independent failed metadata and no partial BIF', async t => {
  const root = await temporaryDirectory(t);
  const manager = new TrickPlayManager({ root, canRun: () => true, runner: async () => { throw new Error('provider refused'); } });
  const spec = { sourceId: 'source-1', contentType: 'movie', contentId: '99', duration: 60, inputUrl: 'https://provider.invalid/movie' };
  await manager.ensure(spec);
  await Promise.all(manager.active.values());
  const state = await manager.status(spec);
  assert.equal(state.status, 'failed');
  await assert.rejects(fs.stat(state.paths.bif));
  await assert.rejects(fs.stat(`${state.paths.bif}.tmp`));
});

test('active playback preempts generation and leaves the asset safely queued', async t => {
  const root = await temporaryDirectory(t);
  let release;
  const runner = ({ signal }) => new Promise((resolve, reject) => {
    release = resolve;
    const abort = () => {
      const error = new Error('preempted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  const manager = new TrickPlayManager({ root, canRun: () => true, runner });
  const spec = { sourceId: 'source-1', contentType: 'movie', contentId: '100', duration: 60, inputUrl: 'https://provider.invalid/movie' };
  await manager.ensure(spec);
  await manager.suspendForPlayback();
  assert.equal((await manager.status(spec)).status, 'queued');
  assert.equal(manager.queue.length, 1);
  release?.();
});

test('rejects traversal identities', async () => {
  const manager = new TrickPlayManager();
  assert.throws(() => manager.paths({ sourceId: '..', contentType: 'movie', contentId: '1' }), /Invalid sourceId/);
  assert.throws(() => manager.paths({ sourceId: 'source', contentType: 'movie', contentId: '../1' }), /Invalid contentId/);
});
