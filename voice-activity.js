// Serializable into the self-contained call page; audio stays in the browser.
export function createVoiceActivityDetector(onChange) {
  let speaking = false, lastVoiceAt = -Infinity, noiseFloor = 0.002;
  return {
    update(samples, now, muted = false) {
      let power = 0;
      for (let i = 0; i < samples.length; i++) power += samples[i] * samples[i];
      const rms = samples.length ? Math.sqrt(power / samples.length) : 0;
      const threshold = Math.max(speaking ? 0.008 : 0.018, noiseFloor * (speaking ? 1.8 : 3));
      if (!muted && rms >= threshold) lastVoiceAt = now;
      if (!speaking && rms < threshold) noiseFloor = noiseFloor * 0.98 + rms * 0.02;
      const next = !muted && now - lastVoiceAt < 650;
      if (muted) lastVoiceAt = -Infinity;
      if (next !== speaking) { speaking = next; onChange(speaking); }
      return speaking;
    },
    reset() {
      lastVoiceAt = -Infinity;
      if (speaking) { speaking = false; onChange(false); }
    },
  };
}
