import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceActivityDetector } from '../voice-activity.js';
const samples = level => new Float32Array(1024).fill(level);
test('background silence stays closed; speech opens immediately and pauses between words do not chatter', () => {
  const changes = [], detector = createVoiceActivityDetector(value => changes.push(value));
  assert.equal(detector.update(samples(0.002), 0), false);
  assert.equal(detector.update(samples(0.03), 25), true);
  assert.equal(detector.update(samples(0), 400), true);
  assert.equal(detector.update(samples(0), 700), false);
  assert.deepEqual(changes, [true, false]);
});
test('manual mute closes immediately and old speech cannot reopen it after unmuting', () => {
  const changes = [], detector = createVoiceActivityDetector(value => changes.push(value));
  detector.update(samples(0.03), 25);
  assert.equal(detector.update(samples(0.03), 50, true), false);
  assert.equal(detector.update(samples(0), 75), false);
  assert.equal(detector.update(samples(0.03), 100), true);
  detector.reset(); assert.deepEqual(changes, [true, false, true, false]);
});

test('call analyzes the original mic while transmitting a separate gated track, and cleans up on hangup', async () => {
  const { wwpCallPageHtml } = await import('../wwp-call-page.js');
  const { runInNewContext } = await import('node:vm');
  const html = await wwpCallPageHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let tick, time = 0, level = 0, peer, closed = false, timerCleared = false;
  const notices = [], elements = new Map(), connectedStreams = [];
  const mic = { enabled: true, stop() { this.stopped = true; } };
  const outgoing = { enabled: true, stop() { this.stopped = true; } };
  const micStream = { getTracks: () => [mic], getAudioTracks: () => [mic] };
  const outgoingStream = { getTracks: () => [outgoing], getAudioTracks: () => [outgoing] };
  class AudioContext {
    state = 'running';
    createMediaStreamSource(stream) { assert.equal(stream, micStream); return { connect: node => connectedStreams.push(node), disconnect() {} }; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: samples => samples.fill(level), disconnect() {} }; }
    createMediaStreamDestination() { return { stream: outgoingStream }; }
    async resume() {} async close() { closed = true; }
  }
  runInNewContext(script, {
    URLSearchParams, Float32Array, performance: { now: () => time },
    location: { search: '?s=session&t=token&role=caller' },
    window: { AudioContext, parent: { postMessage: message => notices.push(message) }, addEventListener() {} },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { classList: { toggle() {}, add() {} } }); return elements.get(id); } },
    navigator: { mediaDevices: { async getUserMedia() { return micStream; } } },
    setInterval(fn) { tick = fn; return 1; }, clearInterval() { timerCleared = true; },
    RTCPeerConnection: class {
      constructor() { peer = this; this.connectionState = 'new'; }
      addTrack(track, stream) { assert.equal(track, outgoing); assert.equal(stream, outgoingStream); }
      async createOffer() { return {}; } async setLocalDescription() {} close() {}
    },
    async fetch(url) { return url.includes('/poll?') ? new Promise(() => {}) : { ok: true }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connectedStreams.length, 2);
  assert.equal(outgoing.enabled, false); assert.equal(mic.enabled, true);
  peer.connectionState = 'connected'; peer.onconnectionstatechange();
  level = 0.04; time = 25; tick(); assert.equal(outgoing.enabled, true);
  level = 0; time = 700; tick(); assert.equal(outgoing.enabled, false);
  level = 0.04; time = 725; tick(); assert.equal(outgoing.enabled, true);
  elements.get('mute').onclick(); assert.equal(outgoing.enabled, false);
  time = 750; tick(); assert.equal(outgoing.enabled, false); assert.equal(mic.enabled, true);
  elements.get('mute').onclick(); assert.equal(outgoing.enabled, false);
  time = 775; tick(); assert.equal(outgoing.enabled, true);
  elements.get('hangup').onclick();
  assert.equal(mic.stopped, true); assert.equal(outgoing.stopped, true);
  assert.equal(timerCleared, true); assert.equal(closed, true);
  assert.equal(notices.at(-1).wwpCall, 'ended');
});
