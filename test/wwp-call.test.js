import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { wwpCallParticipantId } from '../wwp-call-identity.js';
import { reconcileWwpSession, setWwpCallRing, appendWwpCallSignal, waitForWwpCallSignals } from '../wwp-sessions.js';

function session() {
  const id = randomUUID();
  reconcileWwpSession(id, { ownerId: 'host', sourceId: 'source', kind: 'movie', id: 'item', start: 0 });
  return id;
}
test('host and ticket-authorized guest remain separate signaling peers for the same media owner', async () => {
  const id = session();
  const host = wwpCallParticipantId('host', null, 'device-token');
  const guest = wwpCallParticipantId('host', { ownerId: 'host' }, 'invitation-ticket');
  assert.notEqual(host, guest);
  assert.equal(wwpCallParticipantId(null, null, 'invalid-ticket'), null);
  setWwpCallRing(id, host, true);
  appendWwpCallSignal(id, host, 'offer', { sdp: 'offer' });
  appendWwpCallSignal(id, host, 'ice', { candidate: 'host-ice' });
  setWwpCallRing(id, guest, false);
  const received = await waitForWwpCallSignals(id, 0, guest, 1);
  assert.deepEqual(received.signals.map(signal => signal.kind), ['offer', 'ice']);
  appendWwpCallSignal(id, guest, 'answer', { sdp: 'answer' });
  appendWwpCallSignal(id, guest, 'ice', { candidate: 'guest-ice' });
  assert.deepEqual((await waitForWwpCallSignals(id, 0, host, 1)).signals.map(signal => signal.kind), ['answer', 'ice']);
});
test('a new call clears stale bye messages while advancing beyond outstanding poll cursors', async () => {
  const id = session();
  appendWwpCallSignal(id, 'host', 'bye', null);
  setWwpCallRing(id, 'host', true);
  appendWwpCallSignal(id, 'host', 'offer', { sdp: 'new-offer' });
  const received = await waitForWwpCallSignals(id, 1, 'guest', 1);
  assert.deepEqual(received.signals.map(signal => signal.kind), ['offer']);
  assert.equal(received.seq, 2);
});
test('call iframe allows the Browser frontend origin', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /frame-ancestors 'self' https:\/\/iptv\.mctoshs\.ca/);
});
test('call page establishes ring state before polling and publishing its offer', async () => {
  const { wwpCallPageHtml } = await import('../wwp-call-page.js');
  const { runInNewContext } = await import('node:vm');
  const html = await wwpCallPageHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const events = [];
  const elements = new Map();
  const window = { addEventListener() {} }; window.parent = window;
  runInNewContext(script, {
    URLSearchParams, location: { search: '?s=session&t=host-token&role=caller' }, window,
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { classList: { toggle() {}, add() {}, remove() {} } }); return elements.get(id); } },
    navigator: { mediaDevices: { async getUserMedia() { return { getTracks: () => [{}] }; } } },
    RTCPeerConnection: class {
      addTrack() {} async createOffer() { return { type: 'offer', sdp: 'test' }; }
      async setLocalDescription(description) { this.localDescription = description; }
    },
    async fetch(url, options) {
      if (url.includes('/ring?')) { events.push('ring'); return { ok: true }; }
      if (url.includes('/poll?')) { events.push('poll'); return new Promise(() => {}); }
      if (url.includes('/signal?')) { events.push(JSON.parse(options.body).kind); return { ok: true }; }
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['ring', 'poll', 'offer']);
});
