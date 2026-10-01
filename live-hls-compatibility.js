import { spawn } from 'node:child_process';
import { normalizeProbe } from './codec-probe.js';
import { audioCompatibility, videoCompatibility } from './playback-strategy.js';
import { selectEnabledHlsStrategy } from './stream-strategy-selection.js';
import { samePlaybackViewer } from './media-session-policy.js';

// Inspect bytes already downloaded by the native relay, without opening a
// competing provider connection. A failed/partial probe stays unknown.
export function probeLiveSegment(body, ffprobe = 'ffprobe') {
  return new Promise(resolve => {
    const child = spawn(ffprobe, ['-v', 'error', '-probesize', '1048576',
      '-analyzeduration', '3000000', '-show_streams', '-show_format', '-of', 'json', 'pipe:0'],
    { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 3000);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const metadata = normalizeProbe(JSON.parse(output));
        resolve(metadata.videoCodec || metadata.audioCodec ? metadata : {});
      } catch { resolve({}); }
    };
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); });
    child.once('error', finish);
    child.once('close', finish);
    child.stdin.on('error', () => {});
    child.stdin.end(body);
  });
}

export function liveCodecFacts(metadata, capabilities, decoderFailure = '') {
  const videoKnown = Boolean(metadata.videoCodec) || decoderFailure === 'decoder-video';
  const audioKnown = Boolean(metadata.audioCodec) || decoderFailure === 'decoder-audio';
  return {
    videoKnown, audioKnown,
    videoCompatible: decoderFailure !== 'decoder-video'
      && (!metadata.videoCodec || videoCompatibility(metadata, capabilities).compatible),
    audioCompatible: decoderFailure !== 'decoder-audio'
      && (!metadata.audioCodec || audioCompatibility(metadata, capabilities).compatible),
  };
}

export function selectLiveHlsStrategy(metadata, capabilities, enabled, options = {}) {
  return selectEnabledHlsStrategy({ ...liveCodecFacts(metadata, capabilities, options.decoderFailure),
    enabled, exact: options.exact || '', downscale: Boolean(options.downscale) });
}

export function pinnedLiveGeneration(job, sourceId, mediaId, identity, enabled) {
  if (!job || job.sourceId !== String(sourceId) || job.mediaId !== String(mediaId)
      || job.kind !== 'channel' || job.userId !== identity.userId
      || !samePlaybackViewer(job, identity)) return { status: 404 };
  if (!enabled[job.hlsStrategy]) return { status: 409 };
  return { job };
}

export function activeLiveStrategy(jobs, sourceId, mediaId, identity, native, loadId = '', kind = 'channel') {
  const job = [...jobs].find(candidate => candidate.kind === kind
    && candidate.sourceId === String(sourceId) && candidate.mediaId === String(mediaId)
    && candidate.userId === identity.userId && samePlaybackViewer(candidate, identity));
  if (job) return { playbackStrategy: job.hlsStrategy, videoMode: job.hlsVideoMode,
    audioMode: job.hlsAudioMode, generationId: job.generationId };
  const active = native?.userId === identity.userId && native.manifests?.size > 0
    && native.viewers?.has(identity.viewerId) && (!loadId || native.loadId === loadId);
  return { playbackStrategy: active ? 'DIRECT' : '', videoMode: active ? 'copy' : '', audioMode: active ? 'copy' : '' };
}
