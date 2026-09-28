export const TIMING_PTS_EPSILON_SECONDS = 0.001;

export function inspectDecodedPts(frames = [], epsilon = TIMING_PTS_EPSILON_SECONDS) {
  let previousPts = null;
  let regressionCount = 0;
  let largestRegressionSeconds = 0;
  let framesChecked = 0;
  for (const frame of frames) {
    const parse = value => value === null || value === undefined || String(value).trim() === '' ? null : Number(value);
    const primary = parse(frame?.pts_time);
    const fallback = parse(frame?.best_effort_timestamp_time);
    const pts = Number.isFinite(primary) ? primary : Number.isFinite(fallback) ? fallback : null;
    if (pts === null) continue;
    framesChecked += 1;
    if (previousPts !== null) {
      const regression = previousPts - pts;
      if (regression > epsilon) {
        regressionCount += 1;
        largestRegressionSeconds = Math.max(largestRegressionSeconds, regression);
      }
    }
    previousPts = pts;
  }
  return {
    checked: true,
    decodedPtsMonotonic: framesChecked > 0 ? regressionCount === 0 : null,
    timingMalformed: regressionCount > 0,
    framesChecked,
    regressionCount,
    largestRegressionSeconds,
  };
}

export function normalizeFrameRate(value) {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(String(value || '').trim());
  if (!match) return '';
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
      || numerator <= 0 || denominator <= 0 || numerator / denominator > 120) return '';
  return `${numerator}/${denominator}`;
}

export function setptsForFrameRate(value) {
  const rate = normalizeFrameRate(value);
  return rate ? `setpts=N/((${rate})*TB)` : '';
}
