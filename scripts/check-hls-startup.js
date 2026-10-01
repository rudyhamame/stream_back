// Offline startup/recovery benchmark. No production/provider connections.
// Requires FFmpeg with -readrate_initial_burst (Roku production image).
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { hlsInputArgs } from '../playback-strategy.js';

const root = await mkdtemp(join(tmpdir(), 'rh-hls-startup-'));
const source = join(root, 'long-gop.mkv');
function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

try {
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'sine=sample_rate=48000', '-t', '60', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-g', '200', '-keyint_min', '200', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);

  async function startup(start, burst) {
    const directory = join(root, `start-${start}-burst-${burst}`);
    await mkdir(directory);
    const manifest = join(directory, 'master.m3u8');
    const started = performance.now();
    const child = spawn('ffmpeg', ['-v', 'error', '-nostats', '-progress', 'pipe:2',
      ...(start ? ['-ss', String(start)] : []), ...hlsInputArgs(false, burst, 1),
      '-i', source, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'hls',
      '-hls_time', '2', '-hls_list_size', '180', '-hls_flags', 'independent_segments+temp_file',
      '-hls_segment_filename', join(directory, 'segment-%06d.ts'), manifest],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    let generated = 0;
    let stderr = '';
    child.stderr.on('data', data => {
      stderr = (stderr + data.toString()).slice(-16_384);
      for (const match of stderr.matchAll(/^out_time_us=(\d+)$/gm)) generated = Math.max(generated, Number(match[1]) / 1e6);
    });
    const closed = new Promise(resolve => child.once('close', resolve));
    try {
      let segments = [];
      while (performance.now() - started < 40_000) {
        try { segments = (await readFile(manifest, 'utf8')).split('\n').filter(line => /^segment-\d{6}\.ts$/.test(line)); } catch {}
        if (segments.length >= 3) break;
        assert.equal(child.exitCode, null, stderr);
        await delay(50);
      }
      assert.ok(segments.length >= 3, stderr);
      const startupMs = performance.now() - started;
      for (const segment of segments.slice(0, 3)) {
        const filename = join(directory, segment);
        const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-read_intervals', '%+#1', '-show_entries', 'frame=key_frame', '-of', 'json', filename]));
        assert.equal(probe.frames?.[0]?.key_frame, 1, `${segment} must begin with a keyframe`);
        run('ffmpeg', ['-v', 'error', '-xerror', '-i', filename, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
      }
      // A burst must not become a continually growing production lead.
      if (burst) {
        const before = generated;
        await delay(4000);
        const advance = generated - before;
        assert.ok(advance >= 2 && advance <= 6, `post-start generation must remain real-time: ${advance}s in 4s`);
      }
      return startupMs;
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      await closed;
    }
  }

  for (const start of [0, 5]) {
    const [baseline, burst] = await Promise.all([startup(start, 0), startup(start, 12)]);
    assert.ok(burst < baseline * 0.8, `burst must improve start=${start}: ${burst} vs ${baseline}`);
    console.log(`start=${start}s: three-segment ready ${Math.round(baseline)}ms -> ${Math.round(burst)}ms; independent segments decode; steady pacing passes`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
