import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { wwpCallPageHtml } from '../wwp-call-page.js';

async function call(platform, { blocked = false, late = false, errorName = 'NotAllowedError' } = {}) {
  const script = (await wwpCallPageHtml()).match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map(), events = [];
  let constraints, release, rejected = blocked;
  const track = { stop() { events.push('stop'); } };
  const stream = { getTracks: () => [track] };
  const audioSession = { set type(value) { events.push(value); } };
  const window = { addEventListener() {} }; window.parent = window;
  runInNewContext(script, {
    URLSearchParams, location: { search: '?s=session&t=token&role=caller' }, window,
    navigator: { ...platform, audioSession, mediaDevices: {
      async getUserMedia(value) {
        constraints = value;
        if (late) await new Promise(resolve => { release = resolve; });
        if (rejected) throw Object.assign(new Error('Capture failed'), { name: errorName });
        return stream;
      },
    } },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { classList: { toggle() {}, add() {} } });
      return elements.get(id);
    } },
    RTCPeerConnection: class {
      addTrack() {} async createOffer() { return {}; }
      async setLocalDescription() {} close() { events.push('close'); }
    },
    async fetch(url) { return url.includes('/poll?') ? new Promise(() => {}) : { ok: true }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { constraints, events, elements, release, allow() { rejected = false; } };
}

for (const platform of [
  { userAgent: 'Mozilla/5.0 (iPad) AppleWebKit Safari' },
  { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit Safari', platform: 'MacIntel', maxTouchPoints: 5 },
]) {
  test(`iPad call avoids voice processing and restores playback after capture stops (${platform.userAgent})`, async () => {
    const c = await call(platform);
    assert.equal(c.constraints.audio.echoCancellation, false);
    assert.equal(c.constraints.audio.noiseSuppression, false);
    assert.equal(c.constraints.audio.autoGainControl, false);
    assert.equal(c.constraints.video, false);
    assert.deepEqual(c.events, []);
    c.elements.get('hangup').onclick();
    assert.deepEqual(c.events, ['stop', 'close', 'playback']);
  });
}
test('desktop calls retain echo cancellation and do not override the audio session', async () => {
  const c = await call({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit Safari', platform: 'MacIntel', maxTouchPoints: 0 });
  assert.equal(c.constraints.audio.echoCancellation, true);
  assert.equal(c.constraints.audio.noiseSuppression, true);
  assert.equal(c.constraints.audio.autoGainControl, true);
  c.elements.get('hangup').onclick();
  assert.deepEqual(c.events, ['stop', 'close']);
});
test('denied iPad microphone permission restores the playback session', async () => {
  const c = await call({ userAgent: 'iPad' }, { blocked: true });
  assert.deepEqual(c.events, ['playback']);
  assert.match(c.elements.get('st').textContent, /Microphone permission denied/);
  assert.equal(c.elements.get('retrymic').hidden, false);
  c.allow(); c.elements.get('retrymic').onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.elements.get('retrymic').hidden, true);
  assert.equal(c.elements.get('st').textContent, 'Calling…');
});
for (const [errorName, message] of [
  ['NotReadableError', /Microphone could not start/],
  ['NotFoundError', /No microphone found/],
  ['OverconstrainedError', /settings unsupported/],
]) {
  test(`capture failure ${errorName} is not misreported as denied permission`, async () => {
    const c = await call({ userAgent: 'iPad' }, { blocked: true, errorName });
    assert.match(c.elements.get('st').textContent, message);
    assert.equal(c.elements.get('retrymic').hidden, false);
  });
}
test('hangup during the iPad permission prompt stops late capture before restoring playback', async () => {
  const c = await call({ userAgent: 'iPad' }, { late: true });
  c.elements.get('hangup').onclick();
  c.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(c.events, ['playback', 'stop', 'playback']);
});
