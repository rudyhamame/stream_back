// Offline regression check: no provider/account traffic or production jobs.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { determineHlsStrategy, getPlaybackCapabilities, hlsCodecArgs, hlsMuxerFlags, hlsPlaylistProfile } from '../playback-strategy.js';
import { inputDurationSeconds } from '../ffmpeg-input-duration.js';

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result;
}
const dir = await mkdtemp(join(tmpdir(), 'rh-hls-output-'));
const source = join(dir, 'fixture.mp4');
run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '50', '-c:a', 'aac', source]);
for (const copy of [false, true]) {
  for (const start of [0, 2]) {
    const name = `${copy ? 'remux' : 'encode'}-${start}`;
    const manifest = join(dir, `${name}.m3u8`);
    const decision = determineHlsStrategy(copy ? { videoCodec: 'h264', audioCodec: 'aac' } : {}, getPlaybackCapabilities('roku'));
    const fastStart = !copy;
    const profile = hlsPlaylistProfile({ fastStart });
    const result = run('ffmpeg', ['-hide_banner', '-nostats', '-loglevel', 'info', '-ss', String(start), '-i', source, '-t', '5', '-map', '0:v:0', '-map', '0:a:0', ...hlsCodecArgs(decision, { fastStart }), '-f', 'hls', '-hls_time', String(profile.segmentSeconds), ...(fastStart ? ['-hls_init_time', '1'] : []), '-hls_flags', hlsMuxerFlags(), '-hls_segment_filename', join(dir, `${name}-%03d.ts`), manifest]);
    assert.equal(inputDurationSeconds(result.stderr), 8, 'must retain full duration after seek');
    const text = await readFile(manifest, 'utf8');
    assert.match(text, /#EXT-X-INDEPENDENT-SEGMENTS/);
    const segments = text.split('\n').filter(line => line.endsWith('.ts'));
    assert.ok(segments.length >= 2);
    for (const segment of segments) {
      const filename = join(dir, segment);
      const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries', 'frame=key_frame', '-of', 'json', filename]).stdout);
      assert.equal(probe.frames?.[0]?.key_frame, 1, `${segment}: opening keyframe`);
      run('ffmpeg', ['-v', 'error', '-xerror', '-i', filename, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    }
    run('ffmpeg', ['-v', 'error', '-xerror', '-i', manifest, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    console.log(`${name}: audio/video decode and independent segment checks passed`);
  }
}
console.log(`Fixtures retained at ${dir}`);
