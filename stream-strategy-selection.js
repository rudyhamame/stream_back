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

export function normalizeHlsStrategy(value) {
  const name = String(value || '').trim().toUpperCase();
  const aliases = {
    REMUX: HLS_MODE.REMUX, 'PREVIEW-REMUX': HLS_MODE.REMUX,
    VIDEO: HLS_MODE.VIDEO, AUDIO: HLS_MODE.AUDIO, FULL: HLS_MODE.FULL,
  };
  return candidates.some(candidate => candidate.strategy === name) ? name : aliases[name] || '';
}

export function selectEnabledHlsStrategy({
  videoCompatible = true, audioCompatible = true, videoKnown = true,
  audioKnown = true, downscale = false, enabled = {}, excluded = [], exact = '',
} = {}) {
  const requiredVideo = videoKnown && (!videoCompatible || downscale);
  const requiredAudio = audioKnown && !audioCompatible;
  const blocked = new Set(excluded);
  for (const candidate of candidates) {
    if (enabled[candidate.strategy] !== true || blocked.has(candidate.strategy)) continue;
    if (exact && candidate.strategy !== exact) continue;
    // Unknown video facts justify only a copy attempt, never speculative encoding.
    if (!videoKnown && candidate.strategy !== HLS_MODE.REMUX) continue;
    if (requiredVideo && candidate.videoMode !== 'transcode') continue;
    if (requiredAudio && candidate.audioMode !== 'transcode') continue;
    return { ...candidate, requiredVideo, requiredAudio, videoKnown, audioKnown };
  }
  return null;
}

// Initial admission and the recovery list use the same facts and checked
// policy. The client receives a finite ordered list, never an invented mode.
export function enabledHlsPlanForMedia(metadata, capabilities, enabled, options = {}) {
  const primary = selectEnabledHlsForMedia(metadata, capabilities, enabled, options);
  const recovery = [];
  if (!primary) return { primary, recovery };
  const excluded = [...(options.excluded || []), primary.strategy];
  while (excluded.length < candidates.length + (options.excluded?.length || 0)) {
    const next = selectEnabledHlsForMedia(metadata, capabilities, enabled, { ...options, exact: '', excluded });
    if (!next) break;
    recovery.push(next.strategy);
    excluded.push(next.strategy);
  }
  return { primary, recovery };
}

// A failed partial conversion must not try the opposite partial lane and
// copy the track that just failed. Re-check the current server checkboxes
// against observed requirements before choosing the next runtime generation.
export function selectEnabledHlsRecovery({ decision = {}, attempted = [], enabled = {}, downscale = false } = {}) {
  const excluded = new Set(attempted);
  if (excluded.has(HLS_MODE.VIDEO)) excluded.add(HLS_MODE.AUDIO);
  if (excluded.has(HLS_MODE.AUDIO)) excluded.add(HLS_MODE.VIDEO);
  return selectEnabledHlsStrategy({
    enabled, excluded: [...excluded],
    videoCompatible: !decision.requiredVideo,
    audioCompatible: !decision.requiredAudio,
    videoKnown: decision.videoKnown === true,
    audioKnown: decision.audioKnown !== false,
    downscale,
  });
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
