import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// A healthy remux can advance through a long GOP before closing a segment.
// Extend its inactivity budget only on real progress, with an absolute cap.
export async function waitForHlsManifest(filename, {
  timeoutMs = 15_000, maxWaitMs = timeoutMs, signal,
  isFinished = () => false, generatedSeconds = () => 0, requiredSegments = 1,
} = {}, {
  readManifest = () => readFile(filename, 'utf8'),
  now = Date.now, sleep = () => delay(75, undefined, { signal }),
} = {}) {
  const started = now();
  let lastAdvance = started;
  let previousSeconds = Math.max(0, Number(generatedSeconds()) || 0);
  let previousSegments = 0;
  while (now() - started < maxWaitMs) {
    signal?.throwIfAborted();
    let segments = 0;
    try {
      const manifest = await readManifest();
      segments = manifest.split('\n').filter(line => /^segment-\d{6}\.(?:ts|m4s)$/.test(line.trim())).length;
      // At the end of a title, even one final segment is a complete response.
      if (segments >= requiredSegments || (segments > 0 && manifest.includes('#EXT-X-ENDLIST'))) return true;
    } catch { /* No complete manifest yet. */ }
    const seconds = Math.max(0, Number(generatedSeconds()) || 0);
    if (seconds > previousSeconds || segments > previousSegments) lastAdvance = now();
    previousSeconds = Math.max(previousSeconds, seconds);
    previousSegments = Math.max(previousSegments, segments);
    if (isFinished() || now() - lastAdvance >= timeoutMs) return false;
    await sleep();
  }
  return false;
}
