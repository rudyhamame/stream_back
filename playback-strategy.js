export const HlsStrategy = Object.freeze({
  REMUX: 'HLS_REMUX',
  PARTIAL_TRANSCODE: 'HLS_PARTIAL_TRANSCODE',
  FULL_TRANSCODE: 'HLS_FULL_TRANSCODE',
});

export const PlaybackStrategy = Object.freeze({
  DIRECT: 'DIRECT',
  REMUX: HlsStrategy.REMUX,
  PARTIAL_TRANSCODE: HlsStrategy.PARTIAL_TRANSCODE,
  TRANSCODE: HlsStrategy.FULL_TRANSCODE,
});

const normalizedCodec = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

export const PlaybackClient = Object.freeze({
  ROKU: 'roku',
  BROWSER: 'browser',
  ANDROID: 'android',
});

const clientDefaults = Object.freeze({
  [PlaybackClient.ROKU]: {
    videoCodecs: ['h264'], audioCodecs: ['aac', 'mp3'],
    hevcMain: false, hevcMain10: false, maxH264Width: 1920, maxH264Height: 1080,
    maxHevcWidth: 3840, maxHevcHeight: 2160, maxAacChannels: 2,
  },
  [PlaybackClient.BROWSER]: {
    videoCodecs: ['h264'], audioCodecs: ['aac', 'mp3'],
    hevcMain: false, hevcMain10: false, maxH264Width: 3840, maxH264Height: 2160,
    maxHevcWidth: 3840, maxHevcHeight: 2160, maxAacChannels: 2,
  },
  [PlaybackClient.ANDROID]: {
    videoCodecs: ['h264'], audioCodecs: ['aac', 'mp3'],
    hevcMain: false, hevcMain10: false, maxH264Width: 3840, maxH264Height: 2160,
    maxHevcWidth: 3840, maxHevcHeight: 2160, maxAacChannels: 2,
  },
});

export function getPlaybackCapabilities(clientType = PlaybackClient.BROWSER, reported = []) {
  const client = Object.hasOwn(clientDefaults, clientType) ? clientType : PlaybackClient.BROWSER;
  const tokens = new Set((Array.isArray(reported) ? reported : String(reported || '').split(','))
    .map(value => String(value).trim().toLowerCase()).filter(Boolean));
  const defaults = clientDefaults[client];
  const audioCodecs = new Set(defaults.audioCodecs);
  for (const codec of ['ac3', 'eac3', 'dts']) if (tokens.has(codec)) audioCodecs.add(codec);
  return {
    ...defaults,
    client,
    videoCodecs: new Set(defaults.videoCodecs),
    audioCodecs,
    hevcMain: tokens.has('hevc-main'),
    hevcMain10: tokens.has('hevc-main10'),
    maxAacChannels: tokens.has('aac-multichannel') ? 8 : defaults.maxAacChannels,
  };
}

function streamBitDepth(metadata = {}) {
  const explicit = Number(metadata.videoBitDepth || metadata.bitDepth || metadata.bitsPerRawSample);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = String(metadata.pixelFormat || metadata.pixFmt || '').match(/(?:p|le|be)(10|12|16)(?:le|be)?$/i);
  return match ? Number(match[1]) : 8;
}

function frameRate(value) {
  const raw = String(value || '');
  if (!raw) return 0;
  const [numerator, denominator] = raw.split('/').map(Number);
  const result = denominator ? numerator / denominator : Number(raw);
  return Number.isFinite(result) ? result : 0;
}

function videoCompatibility(metadata, capabilities) {
  const codec = normalizedCodec(metadata.videoCodec || metadata.codecVideo || metadata.codec);
  if (!codec) return { compatible: false, reason: 'video codec unavailable' };
  const profile = normalizedCodec(metadata.videoProfile || metadata.profile);
  const pixelFormat = String(metadata.pixelFormat || metadata.pixFmt || '').toLowerCase();
  const bitDepth = streamBitDepth(metadata);
  const width = Number(metadata.width) || 0;
  const height = Number(metadata.height) || 0;
  const fps = frameRate(metadata.frameRate || metadata.avgFrameRate || metadata.rFrameRate);
  const is420 = !pixelFormat || /^(?:yuvj?420p|nv12|p010)/.test(pixelFormat);
  const h264 = ['h264', 'avc', 'avc1'].includes(codec);
  const hevc = ['hevc', 'h265', 'hev1', 'hvc1'].includes(codec);
  if (h264) {
    if (!capabilities.videoCodecs.has('h264')) return { compatible: false, reason: 'H.264 unavailable on target' };
    if (profile && !['baseline', 'constrainedbaseline', 'main', 'high'].includes(profile)) return { compatible: false, reason: `H.264 profile ${profile} unsupported` };
    if (!is420 || bitDepth > 8) return { compatible: false, reason: `H.264 ${pixelFormat || `${bitDepth}-bit`} unsupported` };
    if ((width > capabilities.maxH264Width) || (height > capabilities.maxH264Height)) return { compatible: false, reason: `H.264 dimensions ${width}x${height} exceed target` };
    if (fps > 60.1) return { compatible: false, reason: `H.264 frame rate ${fps.toFixed(2)} exceeds target` };
    return { compatible: true, reason: 'H.264 stream is target-compatible' };
  }
  if (hevc) {
    if (!is420 || bitDepth > 10) return { compatible: false, reason: `HEVC ${pixelFormat || `${bitDepth}-bit`} unsupported` };
    if ((width > capabilities.maxHevcWidth) || (height > capabilities.maxHevcHeight)) return { compatible: false, reason: `HEVC dimensions ${width}x${height} exceed target` };
    if (fps > 60.1) return { compatible: false, reason: `HEVC frame rate ${fps.toFixed(2)} exceeds target` };
    const main10 = bitDepth > 8 || profile.includes('main10');
    if (main10 && !capabilities.hevcMain10) return { compatible: false, reason: 'HEVC Main 10 unavailable on target' };
    if (!main10 && !capabilities.hevcMain) return { compatible: false, reason: 'HEVC unavailable on target' };
    return { compatible: true, reason: `HEVC ${main10 ? 'Main 10' : 'Main'} stream is target-compatible` };
  }
  return { compatible: false, reason: `video codec ${codec} requires H.264 conversion` };
}

function audioCompatibility(metadata, capabilities) {
  const codec = normalizedCodec(metadata.audioCodec || metadata.codecAudio);
  if (!codec) return { compatible: false, reason: 'audio codec unavailable', outputChannels: 2 };
  const channels = Math.max(0, Number(metadata.audioChannels || metadata.channels) || 0);
  const sampleRate = Math.max(0, Number(metadata.audioSampleRate || metadata.sampleRate) || 0);
  if (!capabilities.audioCodecs.has(codec)) return { compatible: false, reason: `audio codec ${codec} unavailable on target`, outputChannels: Math.min(channels || 2, capabilities.maxAacChannels) };
  if (codec === 'aac' && channels > capabilities.maxAacChannels) return { compatible: false, reason: `${channels}-channel AAC unavailable on target`, outputChannels: capabilities.maxAacChannels };
  if (codec === 'aac' && sampleRate && ![44100, 48000].includes(sampleRate)) return { compatible: false, reason: `AAC sample rate ${sampleRate} unavailable on target`, outputChannels: Math.min(channels || 2, capabilities.maxAacChannels) };
  return { compatible: true, reason: `${codec.toUpperCase()} stream is target-compatible`, outputChannels: channels || 2 };
}

export function determineHlsStrategy(sourceMetadata = {}, capabilities = getPlaybackCapabilities()) {
  const video = videoCompatibility(sourceMetadata, capabilities);
  const audio = audioCompatibility(sourceMetadata, capabilities);
  const videoCompatible = video.compatible;
  const audioCompatible = audio.compatible;
  const detail = `${video.reason}; ${audio.reason}`;

  if (videoCompatible && audioCompatible) {
    return { videoMode: 'copy', audioMode: 'copy', strategy: HlsStrategy.REMUX, reason: detail };
  }
  if (videoCompatible) {
    return { videoMode: 'copy', audioMode: 'transcode', outputAudioChannels: audio.outputChannels, strategy: HlsStrategy.PARTIAL_TRANSCODE, reason: detail };
  }
  if (audioCompatible) {
    return { videoMode: 'transcode', audioMode: 'copy', strategy: HlsStrategy.PARTIAL_TRANSCODE, reason: detail };
  }
  return { videoMode: 'transcode', audioMode: 'transcode', outputAudioChannels: audio.outputChannels, strategy: HlsStrategy.FULL_TRANSCODE, reason: detail };
}

export function determineVodHlsStrategy(extension = '', forceFullTranscode = false) {
  if (forceFullTranscode) {
    return {
      videoMode: 'transcode', audioMode: 'transcode', strategy: HlsStrategy.FULL_TRANSCODE,
      reason: 'Compatibility fallback after stream-copy failure',
    };
  }
  const container = String(extension || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  // The selected provider exposes these containers as normal H.264/AAC VOD.
  // Remuxing changes only the container, starts quickly, and avoids Render CPU
  // starvation. It also avoids a separate ffprobe connection on one-slot
  // Xtream accounts. Less predictable containers retain compatibility mode.
  if (['mp4', 'm4v', 'mov'].includes(container)) {
    return {
      videoMode: 'copy', audioMode: 'copy', strategy: HlsStrategy.REMUX,
      reason: `Fast ${container.toUpperCase()} VOD remux`,
    };
  }
  return {
    videoMode: 'transcode', audioMode: 'transcode', strategy: HlsStrategy.FULL_TRANSCODE,
    reason: `Compatibility transcode for ${container || 'unknown'} VOD container`,
  };
}

export function hlsCodecArgs(decision) {
  const args = decision.videoMode === 'copy'
    ? ['-c:v', 'copy']
    : [
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level', '4.0',
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
    ];
  args.push(...(decision.audioMode === 'copy'
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', String(Math.max(1, Number(decision.outputAudioChannels) || 2))]));
  return args;
}

export function fallbackHlsStrategy(decision) {
  if (decision.videoMode === 'copy' && decision.audioMode === 'copy') {
    return {
      videoMode: 'copy', audioMode: 'transcode', outputAudioChannels: 2,
      strategy: HlsStrategy.PARTIAL_TRANSCODE, reason: 'Bounded fallback after copy/copy muxing failure',
    };
  }
  return {
    videoMode: 'transcode', audioMode: 'transcode', outputAudioChannels: 2,
    strategy: HlsStrategy.FULL_TRANSCODE, reason: 'Bounded compatibility fallback after partial strategy failure',
  };
}

export function strategyUsesEncoding(decision) {
  return decision.videoMode === 'transcode' || decision.audioMode === 'transcode';
}

export function hlsPlaylistProfile() {
  return { segmentSeconds: 2, initialSegmentSeconds: 0, listSize: 30, startupSegments: 1 };
}

export function hlsInputArgs() {
  // Render's FFmpeg build supports -readrate but not the newer
  // -readrate_initial_burst option. Keep playback paced without passing an
  // unsupported argument that makes every HLS job exit before startup.
  return ['-readrate', '1'];
}

export function hlsMuxerFlags() {
  return 'independent_segments+temp_file+delete_segments';
}

export function choosePlaybackStrategy({ purpose } = {}) {
  if (purpose === 'direct-proxy') return PlaybackStrategy.DIRECT;
  return PlaybackStrategy.REMUX;
}
