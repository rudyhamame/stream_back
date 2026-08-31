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

const compatibleVideoCodecs = new Set(['h264', 'avc', 'avc1', 'mpeg4']);
const compatibleAudioCodecs = new Set(['aac', 'mp3', 'mp2']);
const normalizedCodec = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

export function determineHlsStrategy(sourceMetadata = {}) {
  const videoCodec = normalizedCodec(sourceMetadata.videoCodec || sourceMetadata.codecVideo || sourceMetadata.codec);
  const audioCodec = normalizedCodec(sourceMetadata.audioCodec || sourceMetadata.codecAudio);
  const videoCompatible = !videoCodec || compatibleVideoCodecs.has(videoCodec);
  const audioCompatible = !audioCodec || compatibleAudioCodecs.has(audioCodec);

  if (videoCompatible && audioCompatible) {
    return { videoMode: 'copy', audioMode: 'copy', strategy: HlsStrategy.REMUX, reason: 'Source codecs are compatible or unavailable' };
  }
  if (videoCompatible) {
    return { videoMode: 'copy', audioMode: 'transcode', strategy: HlsStrategy.PARTIAL_TRANSCODE, reason: `Audio codec ${audioCodec} requires AAC conversion` };
  }
  if (audioCompatible) {
    return { videoMode: 'transcode', audioMode: 'copy', strategy: HlsStrategy.PARTIAL_TRANSCODE, reason: `Video codec ${videoCodec} requires H.264 conversion` };
  }
  return { videoMode: 'transcode', audioMode: 'transcode', strategy: HlsStrategy.FULL_TRANSCODE, reason: 'Video and audio codecs require conversion' };
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
    : ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']));
  return args;
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
