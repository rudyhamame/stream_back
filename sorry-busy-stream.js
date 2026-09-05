import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// A tiny, self-contained HLS clip played instead of a JSON error whenever a
// strictSharedLine provider's one connection is already in use (see
// playlist-rules.js / ProviderLineBusyError). Generated once with ffmpeg and
// cached on disk - every subsequent "busy" hit is a static file read, no
// ffmpeg spawn, so a flood of refused requests costs nothing extra.
const sorryDir = path.join(os.tmpdir(), 'rh-stream-hls', '_sorry-busy');
const sorryManifest = path.join(sorryDir, 'master.m3u8');
const sorryLines = ['Sorry, someone else is streaming right now.', 'Please wait until the server is ready for you.'];

let ensurePromise;

async function generateSorryClip() {
  await fs.mkdir(sorryDir, { recursive: true });
  const fontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  // Two chained drawtext filters, one per line, each escaped and quoted as its
  // own filter argument - a single textfile with an embedded newline rendered
  // a stray "missing glyph" box for the line-break character on this ffmpeg
  // build, so line splitting is done here instead of inside the filter.
  const escapeDrawtext = value => value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const lineHeight = 64;
  const baseY = `(h-${sorryLines.length * lineHeight})/2`;
  const drawtext = sorryLines.map((line, index) => [
    `drawtext=fontfile=${fontFile}`,
    `text='${escapeDrawtext(line)}'`,
    'fontcolor=white', 'fontsize=42',
    'x=(w-text_w)/2', `y=${baseY}+${index * lineHeight}`,
    'box=1', 'boxcolor=black@0.45', 'boxborderw=14',
  ].join(':')).join(',');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x1b1f27:s=1280x720:r=25:d=8',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '8',
    '-vf', drawtext,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'main',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(sorryDir, 'segment-%06d.ts'),
    sorryManifest,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`))));
  });
}

// Idempotent and concurrency-safe: the first caller generates the clip, every
// later caller (including ones that arrive while generation is in flight)
// awaits the same promise instead of spawning a second ffmpeg.
export async function ensureSorryBusyStream() {
  if (!ensurePromise) {
    ensurePromise = fs.access(sorryManifest).catch(() => generateSorryClip()).catch(error => { ensurePromise = undefined; throw error; });
  }
  await ensurePromise;
  return sorryDir;
}

export function sorryBusyDirectory() {
  return sorryDir;
}
