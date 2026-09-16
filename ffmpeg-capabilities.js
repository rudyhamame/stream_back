import { execFileSync } from 'node:child_process';

// Same resolution as server.js: an override for a build with working hwaccel,
// else whatever "ffmpeg" is on PATH.
const bin = process.env.FFMPEG_BIN || 'ffmpeg';

let helpText;
function help() {
  if (helpText === undefined) {
    try {
      // `-h full` is ~1.2MB; the default 1MB maxBuffer truncates it before the
      // HLS demuxer section and every flag there reads as unsupported.
      helpText = execFileSync(bin, ['-hide_banner', '-h', 'full'], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      helpText = '';
    }
  }
  return helpText;
}

// The hardened HLS demuxer (ffmpeg 7.0+) rejects segment URLs whose extension
// isn't allowlisted - including extensionless provider token URLs - and playback
// never leaves 13% buffered. The opt-out flags differ by version: 6.1.x has only
// -allowed_extensions; -allowed_segment_extensions and -extension_picky came in
// 7.0. Passing an unknown one makes ffmpeg exit before opening the input (Roku
// then loops 0% -> 13%), so emit only what this binary actually understands.
export function hlsExtensionAllowlistArgs() {
  const text = help();
  const args = ['-allowed_extensions', 'ALL'];
  if (text.includes('allowed_segment_extensions')) args.push('-allowed_segment_extensions', 'ALL');
  if (text.includes('extension_picky')) args.push('-extension_picky', '0');
  return args;
}
