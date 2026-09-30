import { audioCompatibility, videoCompatibility } from './playback-strategy.js';

// Pure compatibility/policy intersection. The server may create an HLS job
// only from a returned decision; a disabled strategy never reaches FFmpeg.
export const HLS_MODE = Object.freeze({
  REMUX: 'HLS_REMUX',
  VIDEO: 'HLS_VIDEO_TRANSCODE',
  AUDIO: 'HLS_AUDIO_TRANSCODE',
  FULL: 'HLS_FULL_TRANSCODE',
});

const candidates = Object.freeze([
  { strategy: HLS_MODE.REMUX, videoMode: 'copy', audioMode: 'copy' },
  { strategy: HLS_MODE.VIDEO, videoMode: 'transcode', audioMode: 'copy' },
  { strategy: HLS_MODE.AUDIO, videoMode: 'copy', audioMode: 'transcode' },
  { strategy: HLS_MODE.FULL, videoMode: 'transcode', audioMode: 'transcode' },
]);

export function selectEnabledHlsStrategy({
  videoCompatible = true, audioCompatible = true, videoKnown = true,
  audioKnown = true, downscale = false, enabled = {}, excluded = [], exact = '',
} = {}) {
  const requiredVideo = videoKnown && (!videoCompatible || downscale);
  const requiredAudio = audioKnown && !audioCompatible;
  const blocked = new Set(excluded);
  for (const candidate of candidates) {
    if (!enabled[candidate.strategy] || blocked.has(candidate.strategy)) continue;
    if (exact && candidate.strategy !== exact) continue;
    // Unknown video facts justify only a copy attempt, never speculative encoding.
    if (!videoKnown && candidate.strategy !== HLS_MODE.REMUX) continue;
    if (requiredVideo && candidate.videoMode !== 'transcode') continue;
    if (requiredAudio && candidate.audioMode !== 'transcode') continue;
    return { ...candidate, requiredVideo, requiredAudio, videoKnown };
  }
  return null;
}

export function selectEnabledHlsForMedia(metadata = {}, capabilities, enabled = {}, options = {}) {
  const videoKnown = Boolean(metadata.videoCodec || metadata.codecVideo || metadata.codec);
  const audioKnown = Boolean(metadata.audioCodec || metadata.codecAudio);
  const video = videoKnown ? videoCompatibility(metadata, capabilities) : null;
  const audio = audioKnown ? audioCompatibility(metadata, capabilities) : null;
  const selected = selectEnabledHlsStrategy({
    videoKnown, audioKnown,
    videoCompatible: video?.compatible ?? true,
    audioCompatible: audio?.compatible ?? true,
    downscale: Boolean(options.downscale), enabled,
    excluded: options.excluded || [], exact: options.exact || '',
  });
  if (!selected) return null;
  return { ...selected, reason: [video?.reason, audio?.reason].filter(Boolean).join('; ') || 'Codec probe incomplete; HLS copy attempt' };
}
