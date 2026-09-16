// The Watch-with-Partner voice call runs entirely in this one self-contained
// page: an <iframe> inside the browser player, and a WebView in the Android
// app. It reads the session id + auth token + role from its own query string,
// runs a single RTCPeerConnection, and relays offer/answer/ICE through the
// streamer's /api/xtream/wwp-call/:id/{poll,signal} endpoints.
//
// It reports lifecycle back to its host two ways, whichever is listening:
//   - browser:  window.parent.postMessage({ wwpCall: 'ended' | 'connected' }, '*')
//   - Android:  window.AndroidCall.onEnded() / onConnected()   (JS interface)
//
// ICE servers are resolved SERVER-SIDE and baked into the page, so the Metered
// API key never reaches the client and the browser makes no third-party call.
//   - Metered (preferred): WWP_TURN_METERED_API_KEY (+ WWP_TURN_METERED_APP, or
//     a full WWP_TURN_METERED_URL). Fresh credentials are fetched from Metered's
//     REST endpoint and cached for WWP_TURN_METERED_TTL_MS (default 30 min).
//   - Static fallback / addition: WWP_TURN_URL (comma-separated) + WWP_TURN_USER
//     + WWP_TURN_PASS.
// Google STUN is always included. A STUN-only call fails whenever both peers sit
// behind symmetric / carrier-grade NAT, which is why TURN matters on mobile.

const STUN_ONLY = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

// Metered's public OpenRelay project TURN - genuinely free & open, no account.
// Shared and rate-limited, so it is a baseline that makes a hard-NAT call
// connect at all; a dedicated relay (WWP_TURN_URL, or a paid Metered plan's
// /api/v1/turn/credential) is preferred and, when set, listed first. Disable
// with WWP_TURN_OPENRELAY=0.
const OPENRELAY_SERVERS = [
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
const openRelayEnabled = String(process.env.WWP_TURN_OPENRELAY ?? '1') !== '0';

const meteredTtlMs = Math.max(60_000, Number.parseInt(process.env.WWP_TURN_METERED_TTL_MS || '1800000', 10) || 1_800_000);
let meteredCache = { servers: null, fetchedAt: 0 };
let meteredInFlight = null;

function meteredCredentialsUrl() {
  if (process.env.WWP_TURN_METERED_URL) return process.env.WWP_TURN_METERED_URL;
  const apiKey = process.env.WWP_TURN_METERED_API_KEY;
  if (!apiKey) return '';
  const app = (process.env.WWP_TURN_METERED_APP || 'rhstreamer').trim().replace(/^https?:\/\//, '').replace(/\.metered\.live.*$/, '');
  return `https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`;
}

function staticTurnServer() {
  const turnUrl = process.env.WWP_TURN_URL;
  if (!turnUrl) return null;
  return {
    urls: turnUrl.split(',').map(s => s.trim()).filter(Boolean),
    username: process.env.WWP_TURN_USER || '',
    credential: process.env.WWP_TURN_PASS || '',
  };
}

async function fetchMeteredServers() {
  const url = meteredCredentialsUrl();
  if (!url) return null;
  if (meteredCache.servers && Date.now() - meteredCache.fetchedAt < meteredTtlMs) return meteredCache.servers;
  if (meteredInFlight) return meteredInFlight;
  meteredInFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const list = await response.json();
      const servers = (Array.isArray(list) ? list : [])
        .filter(entry => entry && entry.urls)
        .map(entry => (entry.username
          ? { urls: entry.urls, username: entry.username, credential: entry.credential }
          : { urls: entry.urls }));
      if (!servers.length) throw new Error('no ICE servers returned');
      meteredCache = { servers, fetchedAt: Date.now() };
      console.log(`[WWP call] Metered TURN credentials refreshed (${servers.length} entries)`);
      return servers;
    } catch (error) {
      console.warn(`[WWP call] Metered TURN fetch failed: ${error.message}${meteredCache.servers ? ' - using cached credentials' : ''}`);
      return meteredCache.servers; // stale-but-usable, or null
    } finally {
      clearTimeout(timer);
      meteredInFlight = null;
    }
  })();
  return meteredInFlight;
}

async function resolveIceServers() {
  const servers = [...STUN_ONLY];
  // Dedicated relay first (better quota / reliability), public OpenRelay last.
  const metered = await fetchMeteredServers();
  if (metered && metered.length) servers.push(...metered);
  const staticTurn = staticTurnServer();
  if (staticTurn && !(metered && metered.length)) servers.push(staticTurn); // fallback only
  if (openRelayEnabled) servers.push(...OPENRELAY_SERVERS);
  return servers;
}

export async function wwpCallPageHtml() {
  const iceServersJson = JSON.stringify(await resolveIceServers());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Watch with Partner call</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; }
  body {
    font: 500 14px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "DM Sans", sans-serif;
    background: #12140f; color: #eef1e6;
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; padding: 10px max(14px, env(safe-area-inset-left)) 10px max(14px, env(safe-area-inset-right));
    user-select: none;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #6b7280; flex: 0 0 auto; transition: background .2s; }
  .dot.live { background: #34d399; box-shadow: 0 0 8px rgba(52,211,153,.6); }
  .dot.warn { background: #fbbf24; }
  .dot.dead { background: #ef4444; }
  .meta { flex: 1 1 auto; min-width: 0; }
  .meta .who { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta .st { font-size: 12px; color: #aab29c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button {
    flex: 0 0 auto; border: 0; border-radius: 999px; width: 40px; height: 40px;
    display: grid; place-items: center; cursor: pointer; background: #262a20; color: #eef1e6;
    font-size: 17px; transition: background .15s, transform .1s;
  }
  button:active { transform: scale(.92); }
  button.muted { background: #f2c14e; color: #1a1a12; }
  button.hangup { background: #ef4444; color: #fff; }
  .tapaudio {
    position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    background: rgba(0,0,0,.7); font-weight: 700; cursor: pointer;
  }
  .tapaudio.show { display: flex; }
</style>
</head>
<body>
  <span class="dot" id="dot"></span>
  <div class="meta">
    <div class="who" id="who">Partner</div>
    <div class="st" id="st">Starting…</div>
  </div>
  <button id="mute" title="Mute" aria-label="Mute">🎤</button>
  <button id="hangup" class="hangup" title="End call" aria-label="End call">✕</button>
  <div class="tapaudio" id="tapaudio">Tap to enable call audio</div>
  <audio id="remote" autoplay playsinline></audio>

<script>
(function () {
  "use strict";
  var ICE_SERVERS = ${iceServersJson};
  var q = new URLSearchParams(location.search);
  var sessionId = q.get("s") || "";
  var token = q.get("t") || "";
  var role = q.get("role") === "caller" ? "caller" : "callee";
  var partnerName = q.get("name") || "Partner";

  var $ = function (id) { return document.getElementById(id); };
  $("who").textContent = partnerName;
  var base = "/api/xtream/wwp-call/" + encodeURIComponent(sessionId);
  var auth = "streamTicket=" + encodeURIComponent(token) + "&deviceToken=" + encodeURIComponent(token);

  var pc = null, localStream = null, since = 0, polling = true, ended = false;
  var pendingIce = [], haveRemote = false, muted = false;

  function setStatus(text, cls) {
    $("st").textContent = text;
    $("dot").className = "dot" + (cls ? " " + cls : "");
  }
  function host(msg) {
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ wwpCall: msg }, "*"); } catch (e) {}
    try { if (window.AndroidCall) { if (msg === "ended" && window.AndroidCall.onEnded) window.AndroidCall.onEnded(); if (msg === "connected" && window.AndroidCall.onConnected) window.AndroidCall.onConnected(); } } catch (e) {}
  }

  function post(kind, data) {
    return fetch(base + "/signal?" + auth, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: kind, data: data }),
    }).catch(function () {});
  }

  function endCall(reason) {
    if (ended) return;
    ended = true; polling = false;
    setStatus(reason || "Call ended", "dead");
    post("bye", null);
    fetch(base + "/ring?ringing=0&" + auth).catch(function () {});
    try { if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    host("ended");
  }

  $("hangup").onclick = function () { endCall("Call ended"); };
  $("mute").onclick = function () {
    if (!localStream) return;
    muted = !muted;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
    $("mute").textContent = muted ? "🔇" : "🎤";
    $("mute").classList.toggle("muted", muted);
  };
  $("tapaudio").onclick = function () {
    var a = $("remote");
    a.play().then(function () { $("tapaudio").classList.remove("show"); }).catch(function () {});
  };

  function attachRemote(stream) {
    var a = $("remote");
    a.srcObject = stream;
    a.play().catch(function () { $("tapaudio").classList.add("show"); });
  }

  function newPeer() {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 2 });
    pc.onicecandidate = function (e) { if (e.candidate) post("ice", e.candidate.toJSON ? e.candidate.toJSON() : e.candidate); };
    pc.ontrack = function (e) { attachRemote(e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track])); };
    pc.oniceconnectionstatechange = function () {
      // A relay-only path can leave connectionState at "connecting" on some
      // engines while iceConnectionState already reports "connected".
      if (pc.iceConnectionState === "failed") { try { pc.restartIce(); } catch (e) {} }
    };
    pc.onconnectionstatechange = function () {
      var s = pc.connectionState;
      if (s === "connected") { setStatus("Connected", "live"); host("connected"); }
      else if (s === "connecting") setStatus("Connecting…", "warn");
      else if (s === "disconnected") setStatus("Reconnecting…", "warn");
      else if (s === "failed") endCall("Call failed");
      else if (s === "closed" && !ended) endCall("Call ended");
    };
  }

  async function flushIce() {
    haveRemote = true;
    while (pendingIce.length) {
      try { await pc.addIceCandidate(pendingIce.shift()); } catch (e) {}
    }
  }

  async function onSignal(m) {
    if (!pc) return;
    try {
      if (m.kind === "offer") {
        await pc.setRemoteDescription(m.data);
        await flushIce();
        var ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        post("answer", pc.localDescription);
      } else if (m.kind === "answer") {
        await pc.setRemoteDescription(m.data);
        await flushIce();
      } else if (m.kind === "ice") {
        if (haveRemote) { try { await pc.addIceCandidate(m.data); } catch (e) {} }
        else pendingIce.push(m.data);
      } else if (m.kind === "bye") {
        endCall("Call ended");
      }
    } catch (e) { setStatus("Signalling error", "dead"); }
  }

  async function pollLoop() {
    while (polling) {
      try {
        var r = await fetch(base + "/poll?since=" + since + "&" + auth, { cache: "no-store" });
        if (!r.ok) { await wait(1500); continue; }
        var j = await r.json();
        if (typeof j.seq === "number") since = Math.max(since, j.seq);
        if (j.signals) for (var i = 0; i < j.signals.length; i++) await onSignal(j.signals[i]);
      } catch (e) { await wait(1500); }
    }
  }
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  async function start() {
    if (!sessionId || !token) { setStatus("Missing session", "dead"); return; }
    setStatus("Requesting microphone…", "warn");
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      setStatus("Microphone blocked", "dead");
      return;
    }
    newPeer();
    localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
    pollLoop();
    // Ring state: the caller sets it (so the partner's wwp-sync prompt appears);
    // the callee clears it on answering so the prompt goes away everywhere.
    fetch(base + "/ring?ringing=" + (role === "caller" ? "1" : "0") + "&" + auth).catch(function () {});
    if (role === "caller") {
      setStatus("Calling…", "warn");
      try {
        var offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        post("offer", pc.localDescription);
      } catch (e) { setStatus("Could not start call", "dead"); }
    } else {
      setStatus("Connecting…", "warn");
    }
  }

  window.addEventListener("pagehide", function () { endCall(); });
  window.addEventListener("message", function (e) {
    if (e.data && e.data.wwpCall === "hangup") endCall("Call ended");
  });
  start();
})();
</script>
</body>
</html>`;
}
