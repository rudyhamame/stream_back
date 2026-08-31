import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIF_MAGIC = Buffer.from([0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER_BYTES = 64;
const INDEX_ENTRY_BYTES = 8;

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const safePart = (value, name) => {
  const text = String(value || '');
  if (!/^[A-Za-z0-9._-]+$/.test(text) || text === '.' || text === '..') throw new Error(`Invalid ${name}`);
  return text;
};

const writeJsonAtomic = async (file, value) => {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
};

export async function createBif(frameFiles, outputFile, intervalSeconds) {
  if (!Array.isArray(frameFiles) || frameFiles.length === 0) throw new Error('No trick-play frames were generated');
  const frameSizes = await Promise.all(frameFiles.map(async file => (await fs.stat(file)).size));
  const indexBytes = (frameFiles.length + 1) * INDEX_ENTRY_BYTES;
  const header = Buffer.alloc(HEADER_BYTES + indexBytes);
  BIF_MAGIC.copy(header, 0);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(frameFiles.length, 12);
  header.writeUInt32LE(positiveInt(intervalSeconds, 10) * 1000, 16);
  let offset = header.length;
  frameSizes.forEach((size, index) => {
    header.writeUInt32LE(index, HEADER_BYTES + index * INDEX_ENTRY_BYTES);
    header.writeUInt32LE(offset, HEADER_BYTES + index * INDEX_ENTRY_BYTES + 4);
    offset += size;
  });
  const finalIndex = HEADER_BYTES + frameFiles.length * INDEX_ENTRY_BYTES;
  header.writeUInt32LE(0xffffffff, finalIndex);
  header.writeUInt32LE(offset, finalIndex + 4);
  const output = await fs.open(outputFile, 'w', 0o600);
  try {
    await output.write(header);
    // Append one JPEG at a time; a multi-hour title's complete BIF is never
    // retained in Node memory.
    for (const frameFile of frameFiles) await output.write(await fs.readFile(frameFile));
    await output.sync();
  } finally {
    await output.close();
  }
  return { thumbnailCount: frameFiles.length, bytes: offset };
}

export async function validateBif(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size < HEADER_BYTES + INDEX_ENTRY_BYTES) throw new Error('BIF is too small');
    const header = Buffer.alloc(HEADER_BYTES);
    await handle.read(header, 0, header.length, 0);
    if (!header.subarray(0, BIF_MAGIC.length).equals(BIF_MAGIC)) throw new Error('BIF magic is invalid');
    if (header.readUInt32LE(8) !== 0) throw new Error('Unsupported BIF version');
    const count = header.readUInt32LE(12);
    if (count < 1 || count > 1_000_000) throw new Error('BIF frame count is invalid');
    const index = Buffer.alloc((count + 1) * INDEX_ENTRY_BYTES);
    await handle.read(index, 0, index.length, HEADER_BYTES);
    let priorOffset = HEADER_BYTES + index.length;
    for (let frame = 0; frame < count; frame += 1) {
      const timestamp = index.readUInt32LE(frame * INDEX_ENTRY_BYTES);
      const offset = index.readUInt32LE(frame * INDEX_ENTRY_BYTES + 4);
      if (timestamp !== frame || offset < priorOffset || offset >= stat.size) throw new Error('BIF index is invalid');
      priorOffset = offset;
    }
    const endIndex = count * INDEX_ENTRY_BYTES;
    if (index.readUInt32LE(endIndex) !== 0xffffffff || index.readUInt32LE(endIndex + 4) !== stat.size) throw new Error('BIF end index is invalid');
    const jpeg = Buffer.alloc(2);
    await handle.read(jpeg, 0, 2, index.readUInt32LE(4));
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('BIF first frame is not JPEG');
    return { thumbnailCount: count, intervalMilliseconds: header.readUInt32LE(16), bytes: stat.size };
  } finally {
    await handle.close();
  }
}

function runFfmpeg({ inputUrl, framePattern, intervalSeconds, width, height, timeoutMs, signal, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    const filter = `fps=1/${intervalSeconds},scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease`;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (/^https?:\/\//i.test(inputUrl)) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    args.push(
      '-skip_frame', 'nokey', '-i', inputUrl, '-map', '0:v:0', '-an', '-sn', '-dn', '-threads', '1',
      '-vf', filter, '-q:v', '5', '-start_number', '0', framePattern,
    );
    const child = spawnProcess('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => {
      child.kill('SIGKILL');
      const error = new Error('Trick-play generation preempted by playback');
      error.name = 'AbortError';
      finish(error);
    };
    child.stderr.on('data', chunk => { errors = `${errors}${chunk}`.slice(-8000); });
    child.once('error', finish);
    child.once('close', code => finish(code === 0 ? null : new Error(errors.trim() || `ffmpeg exited with ${code}`)));
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Trick-play generation timed out'));
    }, timeoutMs);
    timeout.unref?.();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

export class TrickPlayManager {
  constructor({
    root = process.env.TRICKPLAY_CACHE_ROOT || path.join(os.tmpdir(), 'rh-trickplay-cache'),
    intervalSeconds = positiveInt(process.env.TRICKPLAY_INTERVAL_SECONDS, 10),
    maxConcurrentJobs = positiveInt(process.env.TRICKPLAY_MAX_CONCURRENT_JOBS, 1),
    timeoutMs = positiveInt(process.env.TRICKPLAY_PROCESS_TIMEOUT_MS, 45 * 60 * 1000),
    retryMs = positiveInt(process.env.TRICKPLAY_RETRY_MS, 6 * 60 * 60 * 1000),
    cacheTtlDays = positiveInt(process.env.TRICKPLAY_CACHE_TTL_DAYS, 30),
    cacheMaxBytes = positiveInt(process.env.TRICKPLAY_CACHE_MAX_BYTES, 5 * 1024 * 1024 * 1024),
    width = 320,
    height = 180,
    version = 1,
    canRun = () => true,
    runner = runFfmpeg,
    now = () => Date.now(),
  } = {}) {
    this.root = root;
    this.intervalSeconds = intervalSeconds;
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.timeoutMs = timeoutMs;
    this.retryMs = retryMs;
    this.cacheTtlMs = cacheTtlDays * 24 * 60 * 60 * 1000;
    this.cacheMaxBytes = cacheMaxBytes;
    this.width = width;
    this.height = height;
    this.version = version;
    this.canRun = canRun;
    this.runner = runner;
    this.now = now;
    this.queue = [];
    this.queued = new Set();
    this.active = new Map();
    this.controllers = new Map();
    this.serving = new Map();
    this.suspendedUntil = 0;
    this.timer = null;
  }

  identity(spec) {
    const sourceId = safePart(spec.sourceId, 'sourceId');
    const contentType = safePart(spec.contentType, 'contentType');
    if (!['movie', 'episode'].includes(contentType)) throw new Error('Invalid contentType');
    const contentId = safePart(spec.contentId, 'contentId');
    return { key: `${sourceId}/${contentType}/${contentId}`, sourceId, contentType, contentId };
  }

  paths(spec) {
    const identity = this.identity(spec);
    const directory = path.join(this.root, identity.sourceId, identity.contentType, identity.contentId);
    return { ...identity, directory, bif: path.join(directory, 'preview.bif'), metadata: path.join(directory, 'metadata.json') };
  }

  async initialize() {
    await fs.mkdir(this.root, { recursive: true });
    await this.cleanupTemporaryFiles(this.root);
    this.timer = setInterval(() => { this.drain().catch(error => console.warn(`[TrickPlay] queue error reason=${error.message}`)); }, 2_000);
    this.timer.unref?.();
  }

  async cleanupTemporaryFiles(directory) {
    let entries = [];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async entry => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name.endsWith('.tmp')) return fs.rm(target, { recursive: true, force: true });
      if (entry.isDirectory()) return this.cleanupTemporaryFiles(target);
      if (entry.name.endsWith('.tmp')) await fs.rm(target, { force: true });
    }));
  }

  async readMetadata(paths) {
    try { return JSON.parse(await fs.readFile(paths.metadata, 'utf8')); } catch { return null; }
  }

  baseMetadata(paths, spec, status) {
    const timestamp = new Date(this.now()).toISOString();
    return {
      version: this.version, sourceId: paths.sourceId, contentType: paths.contentType, contentId: paths.contentId,
      extension: String(spec.extension || ''), duration: Math.max(0, Number(spec.duration) || 0),
      intervalSeconds: this.intervalSeconds, thumbnailCount: 0, resolution: `${this.width}x${this.height}`,
      status, createdAt: timestamp, updatedAt: timestamp, lastAccessedAt: timestamp, error: '',
    };
  }

  async status(spec) {
    const paths = this.paths(spec);
    const metadata = await this.readMetadata(paths);
    if (!metadata) return { status: 'missing', paths, metadata: null };
    const compatible = metadata.version === this.version && metadata.intervalSeconds === this.intervalSeconds && metadata.resolution === `${this.width}x${this.height}`;
    if (!compatible) return { status: 'missing', paths, metadata };
    if (metadata.status === 'ready') {
      try { await validateBif(paths.bif); } catch { return { status: 'missing', paths, metadata }; }
    }
    return { status: metadata.status || 'missing', paths, metadata };
  }

  async ensure(spec) {
    const duration = Math.max(0, Number(spec.duration) || 0);
    if (duration <= 0) return { status: 'missing', reason: 'duration-unavailable' };
    const current = await this.status(spec);
    if (current.status === 'ready') {
      console.log(`[TrickPlay] cache hit ${current.paths.contentType}=${current.paths.contentId}`);
      return current;
    }
    if (this.active.has(current.paths.key) || this.queued.has(current.paths.key)) {
      console.log(`[TrickPlay] duplicate job suppressed ${current.paths.contentType}=${current.paths.contentId}`);
      return { ...current, status: this.active.has(current.paths.key) ? 'generating' : 'queued' };
    }
    if (current.status === 'failed' && Date.parse(current.metadata?.updatedAt || 0) + this.retryMs > this.now()) return current;
    this.queued.add(current.paths.key);
    let metadata;
    try {
      await fs.mkdir(current.paths.directory, { recursive: true });
      metadata = { ...this.baseMetadata(current.paths, spec, 'queued'), createdAt: current.metadata?.createdAt || new Date(this.now()).toISOString() };
      await writeJsonAtomic(current.paths.metadata, metadata);
      this.queue.push({ ...spec, duration, paths: current.paths, metadata });
    } catch (error) {
      this.queued.delete(current.paths.key);
      throw error;
    }
    console.log(`[TrickPlay] queued ${current.paths.contentType}=${current.paths.contentId}`);
    void this.drain();
    return { status: 'queued', paths: current.paths, metadata };
  }

  async drain() {
    while (this.active.size < this.maxConcurrentJobs && this.queue.length > 0 && this.now() >= this.suspendedUntil && this.canRun()) {
      const job = this.queue.shift();
      this.queued.delete(job.paths.key);
      const controller = new AbortController();
      this.controllers.set(job.paths.key, controller);
      const promise = this.generate(job, controller.signal).finally(() => {
        this.controllers.delete(job.paths.key);
        this.active.delete(job.paths.key);
        void this.drain();
      });
      this.active.set(job.paths.key, promise);
    }
  }

  async generate(job, signal) {
    const { paths } = job;
    const startedAt = this.now();
    const frameDirectory = path.join(paths.directory, 'frames.tmp');
    const temporaryBif = `${paths.bif}.tmp`;
    const metadata = { ...job.metadata, status: 'generating', updatedAt: new Date(startedAt).toISOString(), error: '' };
    await writeJsonAtomic(paths.metadata, metadata);
    console.log(`[TrickPlay] generation started ${paths.contentType}=${paths.contentId}`);
    try {
      await fs.rm(frameDirectory, { recursive: true, force: true });
      await fs.mkdir(frameDirectory, { recursive: true });
      await this.runner({
        inputUrl: job.inputUrl, framePattern: path.join(frameDirectory, '%08d.jpg'), intervalSeconds: this.intervalSeconds,
        width: this.width, height: this.height, timeoutMs: this.timeoutMs, signal,
      });
      const frames = (await fs.readdir(frameDirectory)).filter(name => /^\d{8}\.jpg$/.test(name)).sort().map(name => path.join(frameDirectory, name));
      const built = await createBif(frames, temporaryBif, this.intervalSeconds);
      const validated = await validateBif(temporaryBif);
      await fs.rename(temporaryBif, paths.bif);
      const ready = {
        ...metadata, status: 'ready', thumbnailCount: validated.thumbnailCount, bytes: built.bytes,
        updatedAt: new Date(this.now()).toISOString(), lastAccessedAt: new Date(this.now()).toISOString(), error: '',
      };
      await writeJsonAtomic(paths.metadata, ready);
      console.log(`[TrickPlay] generation ready ${paths.contentType}=${paths.contentId} frames=${ready.thumbnailCount} duration=${Math.round((this.now() - startedAt) / 1000)}s`);
    } catch (error) {
      await fs.rm(temporaryBif, { force: true });
      if (error.name === 'AbortError') {
        const queued = { ...metadata, status: 'queued', updatedAt: new Date(this.now()).toISOString(), error: '' };
        await writeJsonAtomic(paths.metadata, queued).catch(() => {});
        this.queue.unshift({ ...job, metadata: queued });
        this.queued.add(paths.key);
        console.log(`[TrickPlay] preempted ${paths.contentType}=${paths.contentId}`);
        return;
      }
      const failed = { ...metadata, status: 'failed', updatedAt: new Date(this.now()).toISOString(), error: String(error.message || error).slice(0, 500) };
      await writeJsonAtomic(paths.metadata, failed).catch(() => {});
      console.warn(`[TrickPlay] generation failed ${paths.contentType}=${paths.contentId} reason=${failed.error}`);
    } finally {
      await fs.rm(frameDirectory, { recursive: true, force: true });
    }
  }

  async readyFile(spec) {
    const current = await this.status(spec);
    if (current.status !== 'ready') return current;
    const nowText = new Date(this.now()).toISOString();
    const metadata = { ...current.metadata, lastAccessedAt: nowText, updatedAt: current.metadata.updatedAt };
    await writeJsonAtomic(current.paths.metadata, metadata).catch(() => {});
    return { ...current, metadata, file: current.paths.bif };
  }

  beginServe(key) { this.serving.set(key, (this.serving.get(key) || 0) + 1); }
  endServe(key) {
    const count = (this.serving.get(key) || 1) - 1;
    if (count > 0) this.serving.set(key, count); else this.serving.delete(key);
  }

  suspendForPlayback(milliseconds = 5_000) {
    this.suspendedUntil = Math.max(this.suspendedUntil, this.now() + milliseconds);
    for (const controller of this.controllers.values()) controller.abort();
  }

  async cleanup() {
    const assets = [];
    const walk = async directory => {
      let entries = [];
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.name === 'metadata.json') {
          const metadata = await this.readMetadata({ metadata: target });
          if (metadata?.status === 'ready') assets.push({ metadata, directory, key: `${metadata.sourceId}/${metadata.contentType}/${metadata.contentId}`, bytes: Number(metadata.bytes) || 0 });
        }
      }
    };
    await walk(this.root);
    assets.sort((a, b) => Date.parse(a.metadata.lastAccessedAt || 0) - Date.parse(b.metadata.lastAccessedAt || 0));
    let total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
    const cutoff = this.now() - this.cacheTtlMs;
    for (const asset of assets) {
      if (this.active.has(asset.key) || this.serving.has(asset.key)) continue;
      if (Date.parse(asset.metadata.lastAccessedAt || 0) >= cutoff && total <= this.cacheMaxBytes) continue;
      await fs.rm(asset.directory, { recursive: true, force: true });
      total -= asset.bytes;
    }
  }

  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.active.values());
  }
}

export const trickPlayDefaults = Object.freeze({ intervalSeconds: 10, width: 320, height: 180, maxConcurrentJobs: 1, version: 1 });
