import { parseHlsMediaSegments } from './hls-native-proxy.js';

// Accumulate only completed EXTINF entries, never FFmpeg's in-flight clock.
// One small cursor survives rolling playlist updates without retaining rows.
export function measuredHlsPreparedRange(manifest, generationId, startSeconds = 0, previous = null) {
  const base = Math.max(0, Number(startSeconds) || 0);
  const state = previous?.generationId === generationId && previous.startSeconds === base
    ? { ...previous } : { generationId, startSeconds: base, availableStartSeconds: base, nextSequence: 0, endSeconds: base };
  const segments = parseHlsMediaSegments(manifest);
  for (const segment of segments) {
    const filename = /^segment-(\d{6})\.(?:ts|m4s)$/.exec(segment.url);
    if (!filename || Number(filename[1]) !== segment.sequence) return null;
    if (segment.sequence < state.nextSequence) continue;
    // Missing earlier durations cannot be guessed from segment count/time.
    if (segment.sequence !== state.nextSequence) return null;
    state.endSeconds += segment.durationSec;
    state.nextSequence += 1;
  }
  // A paused player may fall behind the rolling window. Do not paint deleted
  // media between its old position and the first currently advertised segment.
  if (segments.length && segments.at(-1).sequence + 1 === state.nextSequence) {
    const windowSeconds = segments.reduce((total, segment) => total + segment.durationSec, 0);
    state.availableStartSeconds = Math.max(state.availableStartSeconds, state.endSeconds - windowSeconds);
  }
  return state;
}
