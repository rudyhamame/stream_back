import 'dotenv/config';
import { inputDurationSeconds } from './ffmpeg-input-duration.js';
import { hlsExtensionAllowlistArgs } from './ffmpeg-capabilities.js';
import express from 'express';
import cors from 'cors';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shapeArabicForRoku } from './arabic-shaper.js';
import { normalizeArabicSearch } from './arabic-search.js';
import { createXtreamSource, deleteXtreamSource, flattenSelection, getAllXtreamSources, getXtreamSource, getXtreamSources, publicXtreamSource, selectionFor, updateXtreamSelection, updateXtreamSource } from './xtream-store.js';
import { evictXtreamCache, getXtreamCatalog, getXtreamCategories, getXtreamSeriesEpisodes, validateXtreamConnection, xtreamCacheStats, xtreamProviderUrl } from './xtream.js';
import { evictM3uCache, getM3uCatalog, getM3uCategories, m3uCacheStats, m3uProviderUrl, validateM3uConnection } from './m3u.js';
import { MediaCapacityError, MediaJobManager, defaultMediaLimits, memoryPressure } from './media-job-manager.js';
import { DirectStreamLimiter } from './direct-stream-limiter.js';
import { hasHlsVariants, hlsResourceId, isHlsManifest, normalizeHlsMasterForRoku, rewriteHlsManifest, rokuSingleVariantMaster } from './hls-native-proxy.js';
import { isPlaybackSupersededForViewer, isSnapshotSupersededForViewer, KeyedSerialExecutor, hlsChildRequestQuery, hlsSessionKey as rokuHlsKey, samePlaybackViewer, scopedPlaybackViewerId } from './media-session-policy.js';
import { applyQualityCeiling, confidentDirectPlayback, HlsStrategy, PlaybackClient, PlaybackStrategy, QUALITY_RUNGS, choosePlaybackStrategy, determineHlsStrategy, fallbackHlsStrategy, getPlaybackCapabilities, hlsCodecArgs, hlsHwDeviceArgs, hlsInputArgs, hlsManifestStartupTimeoutMs, hlsMuxerFlags, hlsPlaylistProfile, strategyUsesEncoding } from './playback-strategy.js';
import { previewFrameSize, previewInputArgs } from './preview-capture-policy.js';
import { getPlayback, getPlaybackHistory, savePlayback } from './playback-store.js';
import { getFavorites, toggleFavorite } from './favorites-store.js';
import { authorizeDeviceSession, changeAccountPassword, claimAutomaticPairing, createDeviceSession, getActiveRokuPlaybackHeartbeats, getLinkedDevices, getPairingInfo, getRokuDeviceSessionStatus, loginAccount, loginDeviceSession, recordDeviceHeartbeat, resolveDeviceToken, setupDeviceSession, unlinkAccountDevice } from './device-sessions.js';
import { enforceStreamingOnly } from './streaming-route-policy.js';
import { releaseOrphanedProviderStreamLeases, providerLeaseKey } from './provider-stream-leases.js';
import { applyWwpControl, appendWwpCallSignal, endWwpSession, getWwpSession, noteWwpPresence, reconcileWwpSession, setWwpCallRing, waitForWwpCallSignals, waitForWwpSession, wwpSyncToken } from './wwp-sessions.js';
import { wwpCallPageHtml } from './wwp-call-page.js';
import { accountOwnerId } from './account-library-owner.js';
import { checkInternetConnection } from './internet-health.js';

const app = express();
// This deployment is a media data plane. Deny every route that is not needed
// to authenticate or deliver a stream before any legacy handler can run.
app.use(enforceStreamingOnly);
const port = process.env.PORT || 8787;
// Roku production normalization keeps the tested Intel VAAPI H.264 encoder.
// Other clients may still use their existing software paths.
const ffmpegBin = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobeBin = process.env.FFPROBE_BIN || 'ffprobe';
const dashboardCache = new Map();
const previewCache = new Map();
const arabicText = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const rokuText = (value) => arabicText.test(String(value || '')) ? shapeArabicForRoku(value) : String(value || '');
const forceRokuFullTranscode = String(process.env.ROKU_FORCE_FULL_TRANSCODE || 'false').toLowerCase() === 'true';
// Roku cannot reliably receive a JSON document containing a provider's entire
// catalog (this source alone has 44,995 series). Keep the initial screen fast;
// additional catalog pages are loaded separately by the Roku client.
// Each series can contain hundreds of episode records. A small page is
// intentional on Render's 256 MB instance; Roku loads further pages only when
// the user reaches the end of the current series list.
const rokuInitialSeriesLimit = Math.min(4, Math.max(1, Number.parseInt(process.env.ROKU_INITIAL_SERIES_LIMIT || '4', 10)));
const rokuSeriesPageLimit = Math.min(30, Math.max(6, Number.parseInt(process.env.ROKU_SERIES_PAGE_LIMIT || '12', 10)));
const rokuMoviePageLimit = 10;
const rokuChannelPageLimit = Math.min(50, Math.max(10, Number.parseInt(process.env.ROKU_CHANNEL_PAGE_LIMIT || '20', 10)));
const xtreamItemsInFlight = new Map();
const rokuHlsRoot = path.join(os.tmpdir(), 'rh-stream-hls');
const frontendUrl = process.env.FRONTEND_URL || 'http://127.0.0.1:8787';
const mediaLimits = defaultMediaLimits();
const debugMediaLogging = String(process.env.DEBUG_MEDIA_LOGGING || 'false').toLowerCase() === 'true';
const mediaJobs = new MediaJobManager({ limits: mediaLimits, debug: debugMediaLogging });
const hlsMaxSegments = Math.max(12, Number.parseInt(process.env.HLS_MAX_SEGMENTS || '36', 10) || 36);
const hlsRetirementGraceMs = Math.max(30_000, Number.parseInt(process.env.HLS_RETIREMENT_GRACE_MS || '60000', 10) || 60_000);
const retiringHlsJobs = new Map();
const hlsGenerationJobs = new Map();
const previewCacheMaxEntries = Math.max(2, Number.parseInt(process.env.PREVIEW_CACHE_MAX_ENTRIES || '12', 10) || 12);
const previewCacheMaxBytes = Math.max(2, Number.parseInt(process.env.PREVIEW_CACHE_MAX_MB || '12', 10) || 12) * 1024 * 1024;
const previewCacheTtlMs = Math.max(60_000, Number.parseInt(process.env.PREVIEW_CACHE_TTL_MS || '3600000', 10) || 3_600_000);
const mediaStreamIdleTimeoutMs = Math.max(10_000, Number.parseInt(process.env.MEDIA_STREAM_IDLE_TIMEOUT_MS || '45000', 10) || 45_000);
// Full-speed read of the opening seconds of a VOD so the first HLS segment is
// written in ~1s rather than waiting a real GOP under -readrate pacing. Needs a
// modern FFmpeg (-readrate_initial_burst); keep 0 on builds that lack it.
const hlsVodInitialBurstSeconds = Math.max(0, Number.parseInt(process.env.HLS_VOD_INITIAL_BURST_SECONDS || '0', 10) || 0);
const hlsVodReadrate = Math.max(1, Number.parseFloat(process.env.HLS_VOD_READRATE || '1') || 1);
const codecProbeTtlMs = Math.max(60_000, Number.parseInt(process.env.CODEC_PROBE_TTL_MS || '21600000', 10) || 21_600_000);
const codecProbeMaxEntries = Math.max(16, Number.parseInt(process.env.CODEC_PROBE_MAX_ENTRIES || '256', 10) || 256);
const maxCodecProbes = Math.max(1, Number.parseInt(process.env.MAX_CODEC_PROBES || '2', 10) || 2);
const maxActiveDirectStreams = Math.max(1, Number.parseInt(process.env.MAX_ACTIVE_DIRECT_STREAMS || '8', 10) || 8);
const maxDirectStreamsPerSource = Math.max(1, Number.parseInt(process.env.MAX_DIRECT_STREAMS_PER_SOURCE || '4', 10) || 4);
const streamTicketSecret = process.env.DEVICE_AUTH_SECRET || 'local-development-secret-change-before-production';
const codecProbeCache = new Map();
const codecProbesInFlight = new Map();
// VOD runtime (seconds) learned while a title is streaming - from the codec
// probe or a one-shot ffprobe on the same provider connection the job holds.
// library_backend reads this via /internal/media-duration when its own probe
// cannot get the single provider slot (the playback is holding it).
const vodDurations = new Map();
function rememberVodDuration(sourceId, kind, id, seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (!sourceId || !id || value <= 0) return;
  vodDurations.set(`${sourceId}:${kind}:${id}`, { seconds: value, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
  for (const [key, entry] of vodDurations) if (entry.expiresAt <= Date.now()) vodDurations.delete(key);
  while (vodDurations.size > 200) vodDurations.delete(vodDurations.keys().next().value);
}
function recallVodDuration(sourceId, kind, id) {
  const entry = vodDurations.get(`${sourceId}:${kind}:${id}`);
  return entry && entry.expiresAt > Date.now() ? entry.seconds : 0;
}
const mediaSourceLocks = new KeyedSerialExecutor();
const nativeHlsResourceLocks = new KeyedSerialExecutor();
const directStreamLimiter = new DirectStreamLimiter({ maxTotal: maxActiveDirectStreams, maxPerSource: maxDirectStreamsPerSource });
const nativeHlsSessions = new Map();
const nativeHlsSessionTtlMs = 60_000;
const nativeHlsSessionMaxEntries = 16;
let previewCacheBytes = 0;
let shuttingDown = false;
let mediaRequestSequence = 0;

function resolveStreamTicket(token, sourceId, kind, id) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', streamTicketSecret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.ownerId && data.exp > Date.now() && data.sourceId === sourceId && data.kind === kind && data.id === id ? data : null;
  } catch { return null; }
}

// Android's ExoPlayer attaches auth as a global HTTP header (DefaultHttpDataSource
// .setDefaultRequestProperties) applied to every request it makes for a media
// item, manifest and segments alike - a header survives onto segment fetches
// where a query param on the manifest URL alone would not (ExoPlayer's HLS
// extractor resolves relative segment URLs from the manifest without
// repeating its query string). A Watch with Partner partner has no device
// token, so this header is how their segment requests authenticate.
function requestStreamTicket(req) {
  return String(req.query.streamTicket || req.get('x-stream-ticket') || '');
}

const sourceType = source => source?.type === 'm3u' ? 'm3u' : 'xtream';
const getSourceCatalog = (source, kind) => sourceType(source) === 'm3u' ? getM3uCatalog(source, kind) : getXtreamCatalog(source, kind);
const getSourceCategories = (source, kind) => sourceType(source) === 'm3u' ? getM3uCategories(source, kind) : getXtreamCategories(source, kind);
const sourceProviderUrl = (source, kind, id, extension = '') => sourceType(source) === 'm3u' ? m3uProviderUrl(source, kind, id) : xtreamProviderUrl(source, kind, id, extension);

// Android already receives the exact media URL when its provider catalog or
// episode list is fetched. Reuse that transient cached value for playback so
// Play does not resolve or reconstruct the URL again. The request is already
// authenticated and scoped to a source owned by that account; the cached URL
// must still be a valid HTTP(S) media URL.
async function requestProviderUrl(req, source, kind, id, extension = '') {
  const supplied = String(req.query.providerURL || '').trim();
  const client = String(req.query.client || '').trim().toLowerCase();
  if (client === PlaybackClient.ANDROID) {
    if (!supplied) {
      const error = new Error('The cached provider URL is unavailable. Refresh the playlist and try again.');
      error.statusCode = 400;
      throw error;
    }
    let parsed;
    try { parsed = new URL(supplied); } catch { /* handled below */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      const error = new Error('The cached provider URL is invalid.');
      error.statusCode = 400;
      throw error;
    }
    // Never turn the public media relay into an arbitrary URL fetcher. The
    // cached value remains the URL used for playback, but it must identify the
    // exact media path owned by this authenticated provider source.
    const expected = await sourceProviderUrl(source, kind, id, extension);
    if (parsed.href !== new URL(expected).href) {
      const error = new Error('The cached provider URL does not match this media item. Refresh the playlist and try again.');
      error.statusCode = 400;
      throw error;
    }
    return supplied;
  }
  const resolved = await sourceProviderUrl(source, kind, id, extension);
  if (supplied && supplied !== resolved) {
    const error = new Error('The provider URL does not match this media item.');
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

// Watch-with-Partner start barrier: distinct viewer ids seen on a session's
// manifest in the last 15s. The manifest is withheld from BOTH players until
// this reaches 2 and the shared job has enough segments, so neither can start
// ahead of the other. Keyed by wwpSessionId.

function clientAddress(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return (forwarded || req.ip || '').replace(/^::ffff:/, '');
}

function mediaIdentity(req) {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  const session = resolveDeviceToken(token);
  const ticket = resolveStreamTicket(requestStreamTicket(req), req.params.sourceId, req.params.kind, req.params.id);
  const client = String(req.query.client || '');
  const baseViewerId = String(session?.deviceId || session?.ownerId || ticket?.ownerId || req.ip || 'anonymous');
  return {
    userId: String(session?.ownerId || ticket?.ownerId || ''),
    deviceId: client === PlaybackClient.BROWSER ? '' : String(session?.deviceId || ''),
    viewerId: scopedPlaybackViewerId(baseViewerId, client, req.query.playbackClientId),
    clientIp: clientAddress(req),
    client,
    wwpSessionId: String(req.query.wwpSessionId || ''),
    // The raw quality rung (e.g. "1080"), not the derived capabilityKey below -
    // this is what a Watch with Partner peer needs to set its own quality
    // selector to, so it must stay in the human-meaningful shape the client
    // itself sent, not the opaque per-target key used for job routing.
    wwpQuality: String(req.query.quality || ''),
    // The client sets this only on a deliberate user seek / quality change, so
    // an error-recovery or follow-the-partner reload (whose start has merely
    // drifted) does not get mistaken for a seek and bounce the other player.
    wwpSeek: String(req.query.wwpSeek || '') === '1',
    playbackAttemptId: String(req.query.playbackAttemptId || ''),
    sessionId: String(req.query.sessionId || ''),
  };
}

function appendTail(current, chunk, maxBytes = 8_000) {
  return `${current}${chunk}`.slice(-maxBytes);
}

function evictCodecProbeCache(now = Date.now()) {
  for (const [key, entry] of codecProbeCache) if (entry.expiresAt <= now) codecProbeCache.delete(key);
  while (codecProbeCache.size > codecProbeMaxEntries) codecProbeCache.delete(codecProbeCache.keys().next().value);
}

// A hard "the provider will not serve this right now" signal from ffmpeg/ffprobe:
// auth/geo blocks (401/403/404), rate/connection limits (402/408/409/423/429/451),
// or a bare "Error opening input". Matching these lets us cache the refusal so a
// retrying client (hls.js retries ~5x, each restart re-probes) does not hammer an
// already-refusing line and make the rate limit worse.
// ponytail: string-match on ffmpeg stderr; upgrade path is a structured exit only if this misclassifies.
const providerRefusalPattern = /error opening input|server returned \d?4\d\d|http error 4\d\d|\b(40[134]|402|405|406|408|409|423|429|451)\b|forbidden|access denied|not found|too many requests|connection limit/i;

function markProviderUnavailable(cacheKey, message, ttlMs = 25_000) {
  if (!cacheKey) return;
  codecProbeCache.delete(cacheKey);
  codecProbeCache.set(cacheKey, { metadata: { providerUnavailable: true, providerError: String(message || '').slice(0, 160) }, expiresAt: Date.now() + ttlMs });
  evictCodecProbeCache();
}

async function inspectProviderCodecs(inputUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobeBin, [
      '-v', 'error', '-rw_timeout', '12000000',
      '-probesize', '1048576', '-analyzeduration', '3000000',
      '-show_entries', 'stream=codec_type,codec_name,profile,level,pix_fmt,bits_per_raw_sample,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,channel_layout:format=format_name,duration',
      '-of', 'json', inputUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Codec probe timed out'));
    }, 15_000);
    timeout.unref?.();
    child.stdout.on('data', chunk => { output = appendTail(output, chunk, 64 * 1024); });
    child.stderr.on('data', chunk => { errorOutput = appendTail(errorOutput, chunk); });
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (code !== 0) return finish(new Error(errorOutput.trim() || `ffprobe exited with ${code}`));
      try {
        const probe = JSON.parse(output);
        const streams = probe.streams || [];
        const video = streams.find(stream => stream.codec_type === 'video') || {};
        const audio = streams.find(stream => stream.codec_type === 'audio') || {};
        finish(null, {
          container: String(probe.format?.format_name || ''),
          containerSeconds: Math.max(0, Math.round(Number(probe.format?.duration) || 0)),
          videoCodec: String(video.codec_name || ''),
          videoProfile: String(video.profile || ''),
          videoLevel: Number(video.level) || 0,
          pixelFormat: String(video.pix_fmt || ''),
          videoBitDepth: Number(video.bits_per_raw_sample) || 0,
          width: Number(video.width) || 0,
          height: Number(video.height) || 0,
          frameRate: String(video.avg_frame_rate || video.r_frame_rate || ''),
          audioCodec: String(audio.codec_name || ''),
          audioProfile: String(audio.profile || ''),
          audioSampleRate: Number(audio.sample_rate) || 0,
          audioChannels: Number(audio.channels) || 0,
          audioChannelLayout: String(audio.channel_layout || ''),
        });
      } catch { finish(new Error('Codec probe returned invalid metadata')); }
    });
  });
}

function playbackTarget(req) {
  const requested = String(req.query.client || '').trim().toLowerCase();
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase();
  const client = Object.values(PlaybackClient).includes(requested)
    ? requested
    : /roku|dvp/.test(userAgent)
      ? PlaybackClient.ROKU
      : /android|media3|exoplayer/.test(userAgent)
        ? PlaybackClient.ANDROID
        : PlaybackClient.BROWSER;
  const reported = String(req.query.caps || '').split(',').map(value => value.trim()).filter(Boolean).sort();
  // Manual quality rung (YouTube-style). "auto"/absent keeps the native
  // strategy; a numeric rung forces a downscale transcode and forks its own
  // ffmpeg job so switching quality does not disturb other viewers.
  const maxHeight = Object.hasOwn(QUALITY_RUNGS, String(req.query.quality || '').trim())
    ? Number(String(req.query.quality).trim())
    : 0;
  return {
    client,
    reported,
    maxHeight,
    capabilities: getPlaybackCapabilities(client, reported),
    key: `${client}:${reported.join(',')}${maxHeight ? `:h${maxHeight}` : ''}${client === PlaybackClient.BROWSER ? `:viewer:${mediaIdentity(req).viewerId}` : ''}`,
  };
}

// A Roku recovery restart can arrive after the initial HLS manifest was
// already accepted but the stream then failed while opening the deep-seek
// segment.  In that case repeating the codec-selected copy/remux strategy
// just recreates the same 13% stall.  The client may explicitly ask for the
// next safe recovery rung; this is deliberately limited to the HLS fallback
// strategies and never changes the normal first-choice decision.
function requestedHlsFallback(req) {
  if (forceRokuFullTranscode && playbackTarget(req).client !== PlaybackClient.BROWSER) return 'full';
  const value = String(req.query.hlsFallback || '').trim().toLowerCase();
  if (value === 'full' || value === HlsStrategy.FULL_TRANSCODE.toLowerCase()) return 'full';
  if (value === 'remux' || value === HlsStrategy.REMUX.toLowerCase()) return 'remux';
  if (value === 'audio' || value === HlsStrategy.AUDIO_TRANSCODE.toLowerCase()) return 'audio';
  if (value === 'video' || value === HlsStrategy.VIDEO_TRANSCODE.toLowerCase()) return 'video';
  return '';
}

function forceHlsFallback(strategy, decision) {
  if (!strategy || !decision) return decision;
  const maxHeight = Number(decision.maxHeight) || 0;
  if (strategy === 'full') {
    return {
      ...decision, videoMode: 'transcode', audioMode: 'transcode',
      outputAudioChannels: Number(decision.outputAudioChannels) || 2,
      maxHeight, strategy: HlsStrategy.FULL_TRANSCODE,
      reason: `${decision.reason}; full transcode explicitly selected`,
    };
  }
  if (strategy === 'remux') return { ...decision, videoMode: 'copy', audioMode: 'copy', maxHeight, strategy: HlsStrategy.REMUX, reason: `${decision.reason}; diagnostic remux override` };
  if (strategy === 'video') return { ...decision, videoMode: 'transcode', audioMode: 'copy', maxHeight, strategy: HlsStrategy.VIDEO_TRANSCODE, reason: `${decision.reason}; video-transcode fallback selected` };
  return {
    ...decision, videoMode: strategy === 'audio' ? 'copy' : (decision.videoMode === 'copy' ? 'copy' : 'transcode'), audioMode: 'transcode',
    outputAudioChannels: Number(decision.outputAudioChannels) || 2,
    maxHeight, strategy: HlsStrategy.AUDIO_TRANSCODE,
    reason: `${decision.reason}; audio-transcode fallback selected`,
  };
}

async function providerCodecMetadata(cacheKey, inputUrl) {
  evictCodecProbeCache();
  const cached = codecProbeCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.metadata;
  if (codecProbesInFlight.has(cacheKey)) return codecProbesInFlight.get(cacheKey);
  if (codecProbesInFlight.size >= maxCodecProbes) return {};

  const pending = inspectProviderCodecs(inputUrl)
    .then(metadata => {
      codecProbeCache.delete(cacheKey);
      codecProbeCache.set(cacheKey, { metadata, expiresAt: Date.now() + codecProbeTtlMs });
      evictCodecProbeCache();
      return metadata;
    })
    .catch(error => {
      console.warn(`[Media probe] ${cacheKey} unavailable: ${error.message}`);
      // A hard provider refusal (expired line / no VOD / IP block) will fail
      // ffmpeg the same way - surface it so the caller can stop fast instead
      // of burning the whole startup window on transcode retries. Cache it
      // briefly so a Roku that re-polls the manifest every few seconds does
      // not hammer an already-refusing provider.
      if (providerRefusalPattern.test(String(error.message || ''))) {
        // Auth/geo blocks stay cached longer; rate limits clear faster so a
        // recovered line becomes playable again without a long dead window.
        const hardBlock = /\b(401|403|404)\b|forbidden|access denied|not found/i.test(String(error.message || ''));
        markProviderUnavailable(cacheKey, error.message, hardBlock ? 60_000 : 25_000);
        return codecProbeCache.get(cacheKey).metadata;
      }
      return {};
    });
  codecProbesInFlight.set(cacheKey, pending);
  try { return await pending; }
  finally { codecProbesInFlight.delete(cacheKey); }
}

function redactSensitiveUrl(value) {
  const text = String(value || '');
  try {
    const parsed = new URL(text);
    for (const key of ['deviceToken', 'token', 'access_token']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '[redacted]');
    }
    return parsed.toString();
  } catch {
    return text.replace(/([?&](?:deviceToken|token|access_token)=)[^&\s]*/gi, '$1[redacted]');
  }
}

function capacityResponse(res, error) {
  if (!(error instanceof MediaCapacityError)) return false;
  res.setHeader('Retry-After', String(error.retryAfterSeconds));
  res.status(error.statusCode).json({ error: error.message, code: 'MEDIA_CAPACITY_FULL' });
  return true;
}

function terminateChild(child, graceMs = 1_500) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    let finished = false;
    let forceTimer;
    const done = () => { if (finished) return; finished = true; clearTimeout(forceTimer); resolve(); };
    child.once('close', done);
    // A SIGSTOP-frozen job (WWP pause) would queue SIGTERM and never exit -
    // wake it first so the kill actually lands.
    try { child.kill('SIGCONT'); } catch { /* already gone */ }
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      if (!finished && child.exitCode === null) child.kill('SIGKILL');
      done();
    }, graceMs);
    forceTimer.unref?.();
  });
}

function evictPreviewCache(now = Date.now(), aggressive = false) {
  for (const [key, entry] of previewCache) {
    if (entry.expires > now) continue;
    previewCache.delete(key);
    previewCacheBytes -= entry.bytes;
  }
  while (previewCache.size > previewCacheMaxEntries || previewCacheBytes > previewCacheMaxBytes) {
    const key = previewCache.keys().next().value;
    const entry = previewCache.get(key);
    previewCache.delete(key);
    previewCacheBytes -= entry?.bytes || 0;
  }
  if (aggressive) {
    while (previewCache.size > 2) {
      const key = previewCache.keys().next().value;
      const entry = previewCache.get(key);
      previewCache.delete(key);
      previewCacheBytes -= entry?.bytes || 0;
    }
  }
}

function cachePreview(key, frame, ttlMs = previewCacheTtlMs) {
  const prior = previewCache.get(key);
  if (prior) previewCacheBytes -= prior.bytes;
  previewCache.delete(key);
  previewCache.set(key, { frame, bytes: frame.length, expires: Date.now() + ttlMs });
  previewCacheBytes += frame.length;
  evictPreviewCache();
}

async function hlsDiskUsageBytes() {
  let total = 0;
  try {
    for (const directory of await fs.readdir(rokuHlsRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      for (const file of await fs.readdir(path.join(rokuHlsRoot, directory.name), { withFileTypes: true })) {
        if (!file.isFile()) continue;
        total += (await fs.stat(path.join(rokuHlsRoot, directory.name, file.name))).size;
      }
    }
  } catch { /* The HLS root may not exist during startup or shutdown. */ }
  return total;
}

async function enforceHlsFileBound(job) {
  // Roku playlists must retain every advertised segment for the lifetime of
  // their generation. FFmpeg and this safety sweep cannot race the player.
  if (!job?.directory) return;
  try {
    const segments = (await fs.readdir(job.directory))
      .filter(name => /^segment-\d{6}\.ts$/.test(name))
      .sort();
    // Never prune a segment still advertised by the manifest. Roku HLS keeps
    // FFmpeg's delete_segments flag off so an old manifest cannot race an
    // unlink; this single application sweep owns deletion instead and retains
    // six extra segments (12 seconds) as a request-race safety margin.
    const keep = Math.max(hlsMaxSegments, hlsPlaylistProfile().listSize + 6);
    const obsolete = segments.slice(0, Math.max(0, segments.length - keep));
    await Promise.allSettled(obsolete.map(name => fs.rm(path.join(job.directory, name), { force: true })));
  } catch { /* Job cleanup may race this safety sweep. */ }
}

function retireHlsGeneration(key, generation) {
  if (!generation?.directory || generation.retirementScheduled) return;
  generation.retirementScheduled = true;
  generation.state = 'retiring';
  retiringHlsJobs.set(generation.generationId, generation);
  const cleanup = async () => {
    if (generation.activeRequests > 0) {
      generation.retirementScheduled = false;
      return retireHlsGeneration(key, generation);
    }
    if (retiringHlsJobs.get(generation.generationId) === generation) retiringHlsJobs.delete(generation.generationId);
    hlsGenerationJobs.delete(generation.generationId);
    await fs.rm(generation.directory, { recursive: true, force: true }).catch(() => {});
  };
  setTimeout(cleanup, hlsRetirementGraceMs).unref?.();
}

function requestOwner(req) {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  const session = resolveDeviceToken(token);
  return session?.ownerId || null;
}

function requestAccount(req) {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  return resolveDeviceToken(token)?.accountId || null;
}

function requestAccountOwner(req) {
  const accountId = requestAccount(req);
  return accountId && /^[a-f0-9]{24}$/i.test(accountId) ? accountOwnerId(accountId) : requestOwner(req);
}

function mediaOwner(req) {
  return requestOwner(req) || resolveStreamTicket(requestStreamTicket(req), req.params.sourceId, req.params.kind, req.params.id)?.ownerId || null;
}

function cityIsoMinute(timeZone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function freshDashboardTimes(data) {
  return { ...data, cities: (data?.cities || []).map(city => ({
    ...city,
    time: cityIsoMinute(city.timezone || 'UTC'),
  })) };
}

function rokuPage(req, defaultLimit) {
  const page = Math.max(0, Number.parseInt(req.query.page || '0', 10) || 0);
  const requestedLimit = Number.parseInt(req.query.limit || String(defaultLimit), 10);
  const limit = Math.min(200, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : defaultLimit));
  return { page, limit, offset: page * limit };
}

function rokuPagePayload(items, pageInfo) {
  const total = items.length;
  const pageItems = items.slice(pageInfo.offset, pageInfo.offset + pageInfo.limit);
  return { items: pageItems, page: pageInfo.page, limit: pageInfo.limit, total, hasMore: pageInfo.offset + pageItems.length < total };
}

function detectXtreamLanguage(item, category) {
  const text = `${category || ''} ${item.title || ''}`;
  const categoryCode = String(category || '').match(/^\s*([A-Za-z]{2})\s*(?:[|:\-]|$)/)?.[1]?.toUpperCase();
  const categoryLanguages = {
    AR: 'Arabic', EN: 'English', AF: 'Afghan', AL: 'Albanian', BE: 'Belarusian', BG: 'Bulgarian',
    DE: 'German', ES: 'Spanish', FR: 'French', HI: 'Hindi', IT: 'Italian', KU: 'Kurdish',
    PT: 'Portuguese', RU: 'Russian', TR: 'Turkish', UR: 'Urdu', FA: 'Persian', NL: 'Dutch',
  };
  if (categoryCode) return categoryLanguages[categoryCode] || categoryCode;
  if (arabicText.test(text) || /\b(arabic|arab|ar)\b/i.test(text)) return 'Arabic';
  const rules = [
    ['English', /\b(english|eng|en)\b/i], ['French', /\b(french|francais|fr)\b/i],
    ['Turkish', /\b(turkish|turk|tr)\b/i], ['Spanish', /\b(spanish|espanol|es)\b/i],
    ['German', /\b(german|deutsch|de)\b/i], ['Italian', /\b(italian|italiano|it)\b/i],
    ['Portuguese', /\b(portuguese|portugues|pt)\b/i], ['Russian', /\b(russian|ru)\b/i],
    ['Hindi', /\b(hindi|hi)\b/i], ['Urdu', /\b(urdu|ur)\b/i],
    ['Persian', /\b(persian|farsi|fa)\b/i], ['Kurdish', /\b(kurdish|kurd|ku)\b/i],
  ];
  for (const [language, pattern] of rules) if (pattern.test(text)) return language;
  return 'Other';
}

function titleLanguageCode(item) {
  const match = String(item?.title || '').match(/^\s*([A-Za-z]{2})\s*(?:[-|:])/);
  return match ? match[1].toUpperCase() : 'OTHER';
}

function displayDuration(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) return raw.length === 5 ? `00:${raw}` : raw;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return raw;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.floor(seconds % 60);
  return [hours, minutes, remaining].map(part => String(part).padStart(2, '0')).join(':');
}

async function getAllXtreamItems(kind, accountOwner) {
  // Always ask the provider for a fresh catalog. No catalog is persisted in
  // MongoDB; saved/library records contain IDs only.
  if (xtreamItemsInFlight.has(kind)) return xtreamItemsInFlight.get(kind);
  const request = (async () => {
    const sources = await getAllXtreamSources(accountOwner);
    const groups = await Promise.all(sources.map(async source => {
      try {
        const [catalog, categories] = await Promise.all([getSourceCatalog(source, kind), getSourceCategories(source, kind)]);
        const categoryNames = new Map(categories.map(category => [category.id, category.name]));
        return catalog.map(item => {
          const category = categoryNames.get(item.categoryId) || source.name || 'Other';
          const language = detectXtreamLanguage(item, category);
          return { ...item, category, language, rokuCategory: rokuText(category), sourceId: source._id, sourceName: source.name };
        });
      } catch (error) {
        console.warn(`[Xtream] Could not refresh ${kind} catalog for ${source.name}: ${error.message}`);
        return [];
      }
    }));
    return groups.flat();
  })();
  xtreamItemsInFlight.set(kind, request);
  try {
    return await request;
  } finally {
    xtreamItemsInFlight.delete(kind);
  }
}

function selectedXtreamItem(source, item) {
  const suppliedCategory = String(item.category || item.categoryName || '').trim();
  // "test" is the source display name, not a media category. Never expose it
  // as a Roku filter when an old saved item is missing category metadata.
  const category = /^test$/i.test(suppliedCategory) || !suppliedCategory ? 'Other' : suppliedCategory;
  return {
    ...item,
    id: String(item.id),
    kind: item.kind,
    sourceId: source._id,
    sourceName: source.name,
    category,
    language: item.language || detectXtreamLanguage(item, category),
    rokuCategory: item.rokuCategory || rokuText(category),
    // The real, untouched provider URL for this item - saved explicitly here
    // (while `source` credentials are in scope) so Roku's Direct attempt can
    // contact the provider itself instead of going through this server as a
    // mediator. See rokuDirectPlaybackUrl() on the Roku client.
    providerUrl: sourceProviderUrl(source, item.kind, item.id, item.extension),
  };
}

async function getRokuSelectedItems(kind, ownerId = null, accountOwner = ownerId) {
  // Roku is fed only from the explicit frontend selection. This avoids
  // downloading and expanding a provider's whole catalog on the TV.
  if (!ownerId) return [];
  const sources = flattenSelection(await getAllXtreamSources(accountOwner), ownerId, accountOwner);
  // Category names are persisted with each selected item. Do not contact the
  // provider just to render a saved Roku library page; that made every page
  // wait for one category request per source.
  const groups = sources.map(source =>
    (Array.isArray(source.enabledItems) ? source.enabledItems : [])
      .filter(item => item?.kind === kind)
      .map(item => selectedXtreamItem(source, item))
  );
  return groups.flat();
}

function directXtreamItem(item) {
  const extension = String(item.extension || '').toLowerCase();
  const playbackUrl = rokuXtreamPlaybackPath(item.sourceId, item.kind, item.id, extension);
  return {
    ...item,
    source: 'xtream',
    favoriteId: `xtream:${item.sourceId}:${item.kind}:${item.id}`,
    url: playbackUrl,
    playbackUrl,
    rokuTitle: rokuText(item.title),
    rokuTextKind: /[A-Za-z]/.test(item.title) ? 'latin' : 'arabic',
    originalFormat: extension || 'mp4',
    streamFormat: rokuXtreamStreamFormat(extension),
  };
}

function rokuXtreamStreamFormat(extension = '') {
  if (forceRokuFullTranscode) return 'hls';
  const ext = String(extension).replace(/^\./, '').toLowerCase();
  if (['mkv', 'mka', 'mks'].includes(ext)) return ext;
  return ['mp4', 'mov', 'm4v'].includes(ext) ? 'mp4' : 'hls';
}

function rokuXtreamPlaybackPath(sourceId, kind, id, extension = '') {
  const ext = String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (forceRokuFullTranscode) {
    const query = new URLSearchParams({ hlsFallback: 'full' });
    if (ext) query.set('ext', ext);
    return `/api/xtream/hls/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}/master.m3u8?${query}`;
  }
  if (rokuXtreamStreamFormat(ext) !== 'hls' && kind !== 'channel') {
    return `/api/xtream/play/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`;
  }
  return `/api/xtream/hls/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}/master.m3u8${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`;
}

// Custom response headers are invisible to browser fetch() across origins
// unless explicitly exposed - the encode-strategy badge reads these.
app.use(cors({ exposedHeaders: ['X-RH-Strategy', 'X-RH-Video-Mode', 'X-RH-Audio-Mode', 'X-RH-Duration'] }));
app.use(express.json());

// Unlike the public /api/health endpoint, this verifies the same signed Roku
// token used by /api/xtream/hls. The Roku status indicator can therefore
// detect a DEVICE_AUTH_SECRET mismatch between Library and Streamer.
app.get('/api/roku/auth-health', (req, res) => {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  const session = resolveDeviceToken(token);
  res.set('Cache-Control', 'no-store');
  if (!session?.ownerId || !session?.deviceId || session.type !== 'roku') {
    console.warn(`[Media HLS] authenticated health rejected token=${token ? 'present-invalid' : 'missing'}`);
    return res.status(401).json({ ok: false, authenticated: false });
  }
  res.json({ ok: true, authenticated: true });
});

// A Direct stream can keep decoding bytes already buffered after the WAN goes
// down. Before an unsupported Direct-container seek destroys that working
// Video node to start HLS, Roku asks the LAN streamer to verify a public HTTP
// path. This probe never opens a second playlist-provider media connection.
app.get('/api/roku/internet-health', async (req, res) => {
  const token = String(req.get('x-device-token') || req.query.deviceToken || '');
  const session = resolveDeviceToken(token);
  res.set('Cache-Control', 'no-store');
  if (!session?.ownerId || !session?.deviceId || session.type !== 'roku') {
    return res.status(401).json({ ok: false, online: false, authenticated: false });
  }
  const result = await checkInternetConnection();
  res.json({ ok: result.online, online: result.online, status: result.status, elapsedMs: result.elapsedMs });
});

// Decide VOD transport before a client assigns media to its player. Direct is
// offered only when a bounded probe supplies every required media fact and the
// requesting client supports that exact container/codec combination. The
// Android can supply the exact runtime URL from its provider-catalog cache;
// other clients resolve it from the authenticated source identity here.
async function playbackDecision(req, source) {
  const { kind, id } = req.params;
  const inputUrl = await requestProviderUrl(req, source, kind, id, req.query.ext);
  const cacheKey = `${source._id}:${kind}:${id}:${String(req.query.ext || '').toLowerCase()}:${createHash('sha256').update(inputUrl).digest('hex').slice(0, 16)}`;
  const metadata = await providerCodecMetadata(cacheKey, inputUrl);
  if (metadata.providerUnavailable) {
    const error = new Error(metadata.providerError || 'Playlist provider unavailable');
    error.statusCode = 502;
    throw error;
  }
  const target = playbackTarget(req);
  const forceFull = forceRokuFullTranscode && target.client === PlaybackClient.ROKU;
  const direct = forceFull
    ? { compatible: false, reason: 'full transcode forced by server policy' }
    : confidentDirectPlayback(metadata, target.capabilities, req.query.ext);
  const selectedHlsDecision = determineHlsStrategy(metadata, target.capabilities);
  const hlsDecision = forceFull ? forceHlsFallback('full', selectedHlsDecision) : selectedHlsDecision;
  const durationSeconds = Math.max(0, Math.round(Number(metadata.containerSeconds) || 0));
  if (durationSeconds > 0) rememberVodDuration(String(source._id), kind, String(id), durationSeconds);
  return {
    ok: true,
    directCompatible: direct.compatible,
    playbackStrategy: direct.compatible ? PlaybackStrategy.DIRECT : hlsDecision.strategy,
    videoMode: direct.compatible ? 'copy' : hlsDecision.videoMode,
    audioMode: direct.compatible ? 'copy' : hlsDecision.audioMode,
    durationSeconds,
    providerURL: inputUrl,
    reason: direct.compatible ? direct.reason : `${direct.reason}; ${hlsDecision.reason}`,
  };
}

// Roku requires a linked Roku token for its capability-bearing decision.
app.get('/api/roku/playback-decision/:sourceId/:kind/:id', async (req, res) => {
  try {
    const token = String(req.get('x-device-token') || req.query.deviceToken || '');
    const session = resolveDeviceToken(token);
    if (!session?.ownerId || !session?.deviceId || session.type !== 'roku') {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const { sourceId, kind, id } = req.params;
    if (!['movie', 'series'].includes(kind)) return res.status(400).json({ ok: false, error: 'Roku VOD kind required' });
    const source = await getXtreamSource(sourceId, requestAccountOwner(req));
    if (!source) return res.status(404).json({ ok: false, error: 'Playlist source not found' });
    res.set('Cache-Control', 'no-store');
    res.json(await playbackDecision(req, source));
  } catch (error) {
    res.status(error.statusCode || 502).json({ ok: false, error: error.message });
  }
});

// Browser and Android use the same matrix with their own capability profile.
// A Watch-with-Partner ticket may resolve the host's source just like HLS.
app.get('/api/xtream/playback-decision/:sourceId/:kind/:id', async (req, res) => {
  try {
    const { sourceId, kind, id } = req.params;
    if (!['movie', 'series'].includes(kind)) return res.status(400).json({ ok: false, error: 'VOD kind required' });
    const ticket = resolveStreamTicket(requestStreamTicket(req), sourceId, kind, id);
    const source = await getXtreamSource(sourceId, ticket?.accountOwnerId || requestAccountOwner(req));
    if (!source) return res.status(404).json({ ok: false, error: 'Playlist source not found' });
    res.set('Cache-Control', 'no-store');
    res.json(await playbackDecision(req, source));
  } catch (error) {
    console.warn(`[PlaybackDecision] ${req.params.kind}:${req.params.id} client=${String(req.query.client || 'browser')} failed: ${error.message}`);
    res.status(error.statusCode || 502).json({ ok: false, error: error.message });
  }
});

// The Roku displays a short-lived QR/device code. The phone signs up or signs
// in, then the Roku polls for approval and receives its token automatically.
app.post('/api/roku/device-session', async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const token = String(req.get('x-device-token') || req.query.deviceToken || '');
    res.json(await createDeviceSession(deviceId, frontendUrl, token));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/roku/device-session', async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const token = String(req.get('x-device-token') || req.query.deviceToken || '');
    res.json(await createDeviceSession(deviceId, frontendUrl, token));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/roku/device-session/status', async (req, res) => {
  try {
    const session = await getRokuDeviceSessionStatus(req.query.code);
    if (!session) return res.status(404).json({ error: 'Pairing code expired' });
    res.json(session);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/roku/device-session/unlink', async (req, res) => {
  try {
    const token = String(req.get('x-device-token') || req.query.deviceToken || '');
    const session = resolveDeviceToken(token);
    if (!session?.accountId || !session?.deviceId) return res.status(401).json({ error: 'Linked Roku authorization is required' });
    const result = await unlinkAccountDevice(session.accountId, session.deviceId);
    if (result.error) return res.status(404).json(result);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/info', async (req, res) => {
  try {
    const session = await getPairingInfo(req.body?.code, req.get('x-device-token'));
    if (!session) return res.status(404).json({ error: 'Pairing code expired or invalid' });
    res.json(session);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/claim', (req, res) => {
  try {
    const result = claimAutomaticPairing(req.body?.code);
    if (result.error) return res.status(result.error.includes('expired') ? 404 : 401).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/authorize', async (req, res) => {
  try {
    const result = await authorizeDeviceSession(req.body?.code, req.get('x-device-token'));
    if (result.error) return res.status(result.error.includes('expired') ? 404 : result.error.includes('different') ? 409 : 401).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/setup', async (req, res) => {
  try {
    const result = await setupDeviceSession(req.body?.code, req.body?.email, req.body?.password);
    if (result.error) return res.status(result.error.includes('expired') ? 404 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/device-session/login', async (req, res) => {
  try {
    const result = await loginDeviceSession(req.body?.code, req.body?.email, req.body?.password);
    if (result.error) return res.status(result.error.includes('expired') ? 404 : 401).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/account/devices', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    if (!accountId) return res.status(401).json({ error: 'Sign in to view linked devices' });
    res.json({ items: await getLinkedDevices(accountId) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/roku/heartbeat', async (req, res) => {
  try {
    const session = resolveDeviceToken(String(req.get('x-device-token') || req.query.deviceToken || ''));
    if (!session?.deviceId) return res.status(401).json({ error: 'Valid Roku device authorization is required' });
    await recordDeviceHeartbeat(session.deviceId, req.body?.streaming === true, clientAddress(req), {
      sourceId: req.body?.sourceId, kind: req.body?.kind, itemId: req.body?.itemId,
      strategy: req.body?.strategy, mode: req.body?.mode,
    });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.delete('/api/account/devices/:deviceId', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    if (!accountId) return res.status(401).json({ error: 'Sign in to unlink a Roku device' });
    const result = await unlinkAccountDevice(accountId, req.params.deviceId);
    if (result.error) return res.status(404).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/account/login', async (req, res) => {
  try {
    const result = await loginAccount(req.body?.email, req.body?.password, req.body?.deviceId);
    if (result.error) return res.status(result.error.startsWith('Incorrect') ? 401 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/account/password', async (req, res) => {
  try {
    const accountId = requestAccount(req);
    const result = await changeAccountPassword(accountId, req.body?.currentPassword, req.body?.newPassword);
    if (result.error) return res.status(result.error.startsWith('Sign in') ? 401 : 400).json(result);
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/live', (_, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, role: 'streaming', uptime: Math.floor(process.uptime()) });
});

app.get('/api/health', async (_, res) => {
  try {
    const xtreamSources = await getXtreamSources();
    res.json({ ok: true, source: 'xtream', storage: { type: 'mongodb', xtreamSources: xtreamSources.length } });
  } catch (error) {
    res.status(503).json({ ok: false, source: 'catalog', storage: { type: 'mongodb', error: error.message } });
  }
});

function diagnosticsAuthorized(req) {
  const expected = String(process.env.INTERNAL_DIAGNOSTICS_TOKEN || '');
  if (!expected) return false;
  const supplied = String(req.get('x-internal-token') || req.get('authorization')?.replace(/^Bearer\s+/i, '') || '');
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function mediaHealthSnapshot() {
  const memory = process.memoryUsage();
  const counts = mediaJobs.counts();
  return {
    uptime: Math.floor(process.uptime()),
    rssMB: Number((memory.rss / 1024 / 1024).toFixed(1)),
    heapUsedMB: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
    externalMB: Number((memory.external / 1024 / 1024).toFixed(1)),
    arrayBuffersMB: Number((memory.arrayBuffers / 1024 / 1024).toFixed(1)),
    freeSystemMemoryMB: Number((os.freemem() / 1024 / 1024).toFixed(1)),
    loadAverage: os.loadavg().map(value => Number(value.toFixed(2))),
    cpuCount: os.availableParallelism?.() || os.cpus().length,
    activeDirectStreams: directStreamLimiter.activeCount,
    activeRemuxJobs: counts.remux,
    activeTranscodes: counts.transcode,
    queuedJobs: counts.queued,
    hlsDiskUsageMB: Number(((await hlsDiskUsageBytes()) / 1024 / 1024).toFixed(1)),
    cacheEntryCounts: {
      xtream: xtreamCacheStats().entries,
      xtreamRequestsInFlight: xtreamCacheStats().inFlight,
      m3u: m3uCacheStats().entries,
      m3uRequestsInFlight: m3uCacheStats().inFlight,
      previews: previewCache.size,
      previewMB: Number((previewCacheBytes / 1024 / 1024).toFixed(1)),
      nativeHlsSessions: nativeHlsSessions.size,
      catalogRequestsInFlight: xtreamItemsInFlight.size,
    },
  };
}

app.get('/internal/media-health', async (req, res) => {
  if (!diagnosticsAuthorized(req)) return res.sendStatus(404);
  res.set('Cache-Control', 'no-store');
  res.json(await mediaHealthSnapshot());
});

function loopbackRequest(req) {
  const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  // rh-api calls this over the rh-internal Docker network now, not
  // localhost - the two used to share a host/process, but are separate
  // containers today. This endpoint is still never reachable from outside
  // Docker (no Caddy route proxies to /internal/*), so trusting the private
  // bridge-network range is equivalent to the old loopback-only guarantee.
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
}

// Per-pid CPU% (jiffies delta between polls) and RSS from /proc.
const procCpuCache = new Map();
const USER_HZ = 100;
function procStats(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const jiffies = Number(fields[11]) + Number(fields[12]); // utime + stime
    const nowNs = process.hrtime.bigint();
    const prev = procCpuCache.get(pid);
    procCpuCache.set(pid, { jiffies, at: nowNs });
    let cpuPercent = null;
    if (prev) {
      const seconds = Number(nowNs - prev.at) / 1e9;
      if (seconds > 0.2) cpuPercent = Math.max(0, Math.round(((jiffies - prev.jiffies) / USER_HZ) / seconds * 100));
    }
    let rssMB = null;
    const rss = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)\s+kB/);
    if (rss) rssMB = Math.round(Number(rss[1]) / 1024 * 10) / 10;
    return { cpuPercent, rssMB };
  } catch { return null; }
}

app.get('/internal/media-duration/:sourceId/:kind/:id', (req, res) => {
  if (!loopbackRequest(req)) return res.sendStatus(404);
  res.json({ seconds: recallVodDuration(String(req.params.sourceId), String(req.params.kind), String(req.params.id)) });
});

app.get('/internal/active-streams', async (req, res) => {
  if (!loopbackRequest(req)) return res.sendStatus(404);
  const port = Number(process.env.PORT) || null;
  const streams = [];
  const livePids = new Set();
  for (const [key, job] of mediaJobs.entries()) {
    if (job.finished) continue;
    const pid = job.child?.pid || null;
    if (pid) livePids.add(pid);
    const proc = pid ? procStats(pid) : null;
    streams.push({
      port, key,
      deviceId: job.deviceId || '',
      userId: job.userId || '',
      viewerId: job.viewerId || '',
      clientIp: job.clientIp || '',
      client: job.client || '',
      sourceId: job.sourceId || '',
      kind: job.kind || '',
      itemId: job.mediaId || '',
      mode: job.mode || (job.persistent ? 'hls' : 'direct'),
      strategy: job.hlsStrategy || job.mode || '',
      videoMode: job.hlsVideoMode || '',
      audioMode: job.hlsAudioMode || '',
      persistent: job.persistent === true,
      viewers: job.viewers ? job.viewers.size : 0,
      startedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      lastAccessAt: job.lastAccessAt ? new Date(job.lastAccessAt).toISOString() : null,
      pid,
      cpuPercent: proc?.cpuPercent ?? null,
      rssMB: proc?.rssMB ?? null,
    });
  }
  // DIRECT Roku playback never creates a streamer/FFmpeg job because the Roku
  // contacts the provider itself. Include the short-lived Roku heartbeat so
  // the RH Server dashboard can still show that session and its strategy.
  const jobDevices = new Set(streams.map(stream => String(stream.deviceId || '')).filter(Boolean));
  for (const heartbeat of await getActiveRokuPlaybackHeartbeats()) {
    if (jobDevices.has(heartbeat.deviceId)) continue;
    streams.push({
      ...heartbeat,
      port,
      persistent: false,
      viewers: 1,
      pid: null,
      cpuPercent: null,
      rssMB: null,
    });
  }
  for (const pid of procCpuCache.keys()) if (!livePids.has(pid)) procCpuCache.delete(pid);
  res.set('Cache-Control', 'no-store');
  res.json({ port, count: streams.length, streams });
});

// A phone-to-Roku handoff must clear every Android job for this provider on
// the Android streamer, not only the item currently visible in PlayerActivity.
// An abandoned prior episode can otherwise retain the provider's only lease:
// Roku Direct then stalls and its HLS recovery is rejected forever at 13%.
app.post('/internal/streams/android-handoff', async (req, res) => {
  if (!loopbackRequest(req)) return res.sendStatus(404);
  const sourceId = String(req.body?.sourceId || '').trim();
  if (!sourceId) return res.status(400).json({ error: 'sourceId required' });
  let stopped = 0;
  const capacityKeys = new Set();
  for (const [key, job] of [...mediaJobs.entries()]) {
    if (job.wwpSessionId || String(job.sourceId || '') !== sourceId
        || String(job.client || '').toLowerCase() !== 'android') continue;
    if (job.capacityKey) capacityKeys.add(String(job.capacityKey));
    if (await mediaJobs.remove(key, 'android-roku-provider-handoff')) stopped += 1;
  }
  // remove() normally releases the lease. Also clear any orphan belonging to
  // this process after the FFmpeg jobs have exited; never touch another
  // streamer's holder.
  for (const capacityKey of capacityKeys) {
    await releaseOrphanedProviderStreamLeases(capacityKey).catch(() => {});
  }
  res.set('Cache-Control', 'no-store');
  res.json({ port: Number(process.env.PORT) || null, stopped });
});

// Watch with Partner: whichever side has an open device session (host) or a
// valid stream ticket for this exact title (partner) can long-poll here to
// learn when the OTHER side seeks/changes quality, and follow. The ticket
// itself (only ever handed to the host and the one invited partner) is the
// authorization - it is what proves this caller was actually invited.
app.get('/api/xtream/wwp-sync/:sessionId', async (req, res) => {
  try {
    const wwpSession = getWwpSession(req.params.sessionId);
    if (!wwpSession) return res.status(404).json({ error: 'Watch with Partner session not found or expired' });
    const ownerId = requestOwner(req)
      || resolveStreamTicket(requestStreamTicket(req), wwpSession.sourceId, wwpSession.kind, wwpSession.id)?.ownerId
      || null;
    if (!ownerId) return res.status(401).json({ error: 'Not authorized for this session' });
    noteWwpPresence(req.params.sessionId, ownerId);
    const since = String(req.query.since || '');
    console.log(`[WWP sync] session=${req.params.sessionId.slice(0, 8)} owner=${String(ownerId).slice(-4)} since="${since}" hold...`);
    const updated = await waitForWwpSession(req.params.sessionId, since);
    if (!updated) return res.status(404).json({ error: 'Watch with Partner session not found or expired' });
    console.log(`[WWP sync] session=${req.params.sessionId.slice(0, 8)} -> token=${wwpSyncToken(updated)} start=${updated.start} quality=${updated.quality} paused=${updated.paused}`);
    res.set('Cache-Control', 'no-store');
    res.json({
      token: wwpSyncToken(updated),
      revision: updated.revision, controlRevision: updated.controlRevision,
      sourceId: updated.sourceId, kind: updated.kind, id: updated.id, extension: updated.extension,
      start: updated.start, quality: updated.quality,
      paused: updated.paused, controlPositionMs: updated.controlPositionMs, controlAt: updated.controlAt,
      ended: updated.ended === true,
      // Leader-follower frame-lock: the follower maps controlAt (server ms) onto
      // its own clock via this, then extrapolates the host's live position.
      serverNow: Date.now(),
      // Voice call: '' = nobody ringing; otherwise the ownerId that tapped
      // "Start call". The other participant compares it to their own id (or
      // just to their local call state) to show the incoming-call prompt.
      callRing: updated.callRing || '',
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ---- Watch with Partner voice call (WebRTC) --------------------------------
// A tiny self-contained call page (served below) runs the RTCPeerConnection on
// both sides - inside an <iframe> in the browser player and a WebView in the
// Android app. These endpoints are the signalling relay + ring state. Auth is
// the same session stream-ticket / device-token as wwp-sync, checked here;
// all are whitelisted in streaming-route-policy.js (POST /signal included).
function wwpCallOwner(req, wwpSession) {
  return requestOwner(req)
    || resolveStreamTicket(requestStreamTicket(req), wwpSession.sourceId, wwpSession.kind, wwpSession.id)?.ownerId
    || null;
}

app.get('/api/xtream/wwp-call/:sessionId/ring', (req, res) => {
  const wwpSession = getWwpSession(req.params.sessionId);
  if (!wwpSession) return res.status(404).json({ error: 'Session not found' });
  const ownerId = wwpCallOwner(req, wwpSession);
  if (!ownerId) return res.status(401).json({ error: 'Not authorized' });
  const ringing = String(req.query.ringing || '1') !== '0';
  setWwpCallRing(req.params.sessionId, ownerId, ringing);
  console.log(`[WWP call] session=${req.params.sessionId.slice(0, 8)} ring=${ringing} by=${String(ownerId).slice(-4)}`);
  res.set('Cache-Control', 'no-store').json({ ok: true });
});

app.get('/api/xtream/wwp-call/:sessionId/poll', async (req, res) => {
  const wwpSession = getWwpSession(req.params.sessionId);
  if (!wwpSession) return res.status(404).json({ error: 'Session not found' });
  const ownerId = wwpCallOwner(req, wwpSession);
  if (!ownerId) return res.status(401).json({ error: 'Not authorized' });
  const result = await waitForWwpCallSignals(req.params.sessionId, req.query.since, ownerId);
  if (!result) return res.status(404).json({ error: 'Session not found' });
  res.set('Cache-Control', 'no-store').json(result);
});

app.post('/api/xtream/wwp-call/:sessionId/signal', (req, res) => {
  const wwpSession = getWwpSession(req.params.sessionId);
  if (!wwpSession) return res.status(404).json({ error: 'Session not found' });
  const ownerId = wwpCallOwner(req, wwpSession);
  if (!ownerId) return res.status(401).json({ error: 'Not authorized' });
  const { kind, data } = req.body || {};
  if (!['offer', 'answer', 'ice', 'bye'].includes(String(kind))) return res.status(400).json({ error: 'Bad signal kind' });
  appendWwpCallSignal(req.params.sessionId, ownerId, kind, data);
  res.set('Cache-Control', 'no-store').json({ ok: true });
});

app.get('/api/xtream/wwp-call/:sessionId/page', async (req, res) => {
  // The page carries no API keys - ICE servers (incl. fresh Metered TURN
  // credentials) are resolved server-side and baked in. It reads only the
  // session id + auth token from its own query string.
  try {
    const html = await wwpCallPageHtml();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    // Allow the browser player to embed this as a same-origin <iframe>.
    res.set('Content-Security-Policy', "frame-ancestors 'self'");
    res.send(html);
  } catch (error) {
    console.warn(`[WWP call] page render failed: ${error.message}`);
    res.sendStatus(500);
  }
});

// Watch with Partner: relay a play/pause (with the exact position it happened
// at) to the other participant. Same ticket/owner authorization as wwp-sync;
// defined before the /api/xtream auth middleware so an invited partner with
// only a stream ticket can reach it.
app.get('/api/xtream/wwp-control/:sessionId', async (req, res) => {
  try {
    const wwpSession = getWwpSession(req.params.sessionId);
    if (!wwpSession) return res.status(404).json({ error: 'Watch with Partner session not found or expired' });
    const ownerId = requestOwner(req)
      || resolveStreamTicket(requestStreamTicket(req), wwpSession.sourceId, wwpSession.kind, wwpSession.id)?.ownerId
      || null;
    if (!ownerId) return res.status(401).json({ error: 'Not authorized for this session' });
    const paused = String(req.query.paused || '') === '1' || String(req.query.paused || '') === 'true';
    const updated = applyWwpControl(req.params.sessionId, {
      paused,
      positionMs: Number(req.query.positionMs) || 0,
    });
    // The shared ffmpeg job is left running (a rolling window); the partner
    // just matches play/pause on their element. Tearing the job down on pause
    // cascaded badly with a flaky provider's constant restarts.
    console.log(`[WWP control] session=${req.params.sessionId.slice(0, 8)} owner=${String(ownerId).slice(-4)} paused=${paused} pos=${req.query.positionMs} -> token=${wwpSyncToken(updated)}`);
    res.set('Cache-Control', 'no-store');
    res.json({ token: wwpSyncToken(updated), controlRevision: updated?.controlRevision || 0 });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Watch with Partner: one participant closed their player -> end the session so
// the other participant's wwp-sync poll returns ended:true and closes too.
// Same authorization as wwp-control; also reachable via navigator.sendBeacon
// (POST) on page unload.
app.all('/api/xtream/wwp-end/:sessionId', async (req, res) => {
  try {
    const wwpSession = getWwpSession(req.params.sessionId);
    if (!wwpSession) return res.json({ ended: true });
    const ownerId = requestOwner(req)
      || resolveStreamTicket(requestStreamTicket(req), wwpSession.sourceId, wwpSession.kind, wwpSession.id)?.ownerId
      || null;
    if (!ownerId) return res.status(401).json({ error: 'Not authorized for this session' });
    endWwpSession(req.params.sessionId);
    console.log(`[WWP end] session=${req.params.sessionId.slice(0, 8)} by=${String(ownerId).slice(-4)}`);
    res.set('Cache-Control', 'no-store');
    res.json({ ended: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.use('/api/xtream', (req, res, next) => {
  if (req.path === '/logo') return next();
  // The "someone else is streaming" clip carries no provider content or
  // per-user data, so it is exempt the same way /logo is - the manifest route
  // redirects here with no streamTicket/deviceToken of its own to forward.
  const hls = req.path.match(/^\/hls\/([^/]+)\/(channel|movie|series)\/([^/]+)\/(?:master\.m3u8|segment-\d{6}\.ts|resource\/[a-f0-9]{24})$/);
  if (hls && resolveStreamTicket(requestStreamTicket(req), decodeURIComponent(hls[1]), hls[2], decodeURIComponent(hls[3]))) return next();
  const direct = req.path.match(/^\/play\/([^/]+)\/(movie|series)\/([^/]+)$/);
  if (direct && resolveStreamTicket(requestStreamTicket(req), decodeURIComponent(direct[1]), direct[2], decodeURIComponent(direct[3]))) return next();
  if (!requestOwner(req)) {
    if (req.path.startsWith('/hls/')) {
      console.warn(`[Media HLS] authorization rejected path=${req.path} token=${req.query.deviceToken ? 'present-invalid' : 'missing'}`);
    }
    return res.status(401).json({ error: 'Pair this browser with a Roku device first' });
  }
  next();
});

// Roku must not try to build the full Xtream catalog during application
// startup. A complete series catalog requires one provider request per
// series, which can outlive Roku's HTTP request window. The Roku client uses
// this endpoint only to verify that Render is reachable; each catalog page is
// fetched separately when the user opens it.
app.get('/api/roku/bootstrap', async (req, res) => {
  try {
    const accountOwner = requestAccountOwner(req);
    const [selectedSeries, selectedMovies, selectedChannels] = await Promise.all([
      getAllXtreamItems('series', accountOwner), getAllXtreamItems('movie', accountOwner), getAllXtreamItems('channel', accountOwner),
    ]);
    const newestFirst = (items) => [...items]
      .sort((a, b) => Number(b.added || 0) - Number(a.added || 0))
      .slice(0, 3);
    const series = newestFirst(selectedSeries).map((item) => ({
      id: `series-search:${item.sourceId}:${item.id}`,
      title: item.title,
      rokuTitle: rokuText(item.title),
      rokuTextKind: /[A-Za-z]/.test(item.title) ? 'latin' : 'arabic',
      category: item.category,
      sourceId: String(item.sourceId),
      seriesId: item.id,
      thumbnail: item.logo,
      added: item.added,
      contentKind: 'series-search',
    }));
    const movies = newestFirst(selectedMovies).map((item) => ({
      ...directXtreamItem(item),
      thumbnail: item.logo,
      kind: 'movie',
      contentKind: 'movie',
      rokuEnabled: true,
    }));
    res.set('Cache-Control', 'no-store');
    res.json({
      items: [...series, ...movies],
      stats: { series: selectedSeries.length, movies: selectedMovies.length, channels: selectedChannels.length },
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/roku/series/categories', async (req, res) => {
  try {
    const seen = new Set();
    const items = [];
    const sources = await getAllXtreamSources(requestAccountOwner(req));
    for (const source of sources) {
      const categories = await getSourceCategories(source, 'series');
      for (const row of categories) {
        const category = row.name || 'Other';
      if (seen.has(category)) continue;
      seen.add(category);
      items.push({
        id: `series-category:${source._id}:${category}`,
        title: category,
        rokuTitle: rokuText(category),
        category,
        language: detectXtreamLanguage({ title: '' }, category),
        contentKind: 'series-category',
      });
      }
    }
    items.sort((a, b) => a.title.localeCompare(b.title));
    res.json({ items });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/roku/search', async (req, res) => {
  try {
    const kind = String(req.query.kind || '');
    const query = String(req.query.q || '').trim().toLocaleLowerCase();
    if (!['series', 'movie', 'channel'].includes(kind) || !query) return res.status(400).json({ error: 'kind and q are required' });
    const normalizedQuery = normalizeArabicSearch(query);
    const live = await getAllXtreamItems(kind, requestAccountOwner(req));
    const matches = live.filter(item => normalizeArabicSearch(item.title).includes(normalizedQuery)).slice(0, 60);
    if (kind === 'series') {
      return res.json({ items: matches.map(item => ({
        id: `series-search:${item.sourceId}:${item.id}`,
        title: item.title,
        rokuTitle: rokuText(item.title),
        category: item.category,
        rokuCategory: item.rokuCategory,
        sourceId: String(item.sourceId),
        seriesId: item.id,
        contentKind: 'series-search',
      })) });
    }
    if (kind === 'channel') return res.json({ items: buildXtreamChannelsPayload(matches) });
    const items = matches.map(item => ({
      ...directXtreamItem(item),
      thumbnail: item.logo,
      duration: item.duration || '',
      kind: 'movie', contentKind: 'movie', rokuEnabled: true,
    }));
    res.json({ items });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/roku/series/detail', async (req, res) => {
  try {
    const sourceId = String(req.query.sourceId || '');
    const seriesId = String(req.query.seriesId || '');
    if (!sourceId || !seriesId) return res.status(400).json({ error: 'sourceId and seriesId are required' });
    const series = (await getAllXtreamItems('series', requestAccountOwner(req))).find(item => String(item.sourceId) === sourceId && item.id === seriesId);
    if (!series) return res.status(404).json({ error: 'Series not found' });
    res.json({ items: await buildXtreamSeriesPayload({ selected: [series], accountOwner: requestAccountOwner(req) }) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

async function buildXtreamMoviesPayload({ limit, selected, accountOwner } = {}) {
  let movies = (selected || await getAllXtreamItems('movie', accountOwner)).slice().sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
  if (Number.isFinite(limit) && limit > 0) movies = movies.slice(0, limit);
  // Browsing must never wait for get_vod_info. Saved metadata is enough for
  // the card; detailed provider metadata can be fetched only when needed.
  return movies.map(item => ({
    ...directXtreamItem(item),
    duration: displayDuration(item.duration),
    kind: 'movie', contentKind: 'movie', rokuEnabled: true,
  }));
}

function buildXtreamChannelsPayload(items) {
  return items.map(item => ({
    ...directXtreamItem(item),
    kind: 'channel', contentKind: 'channel',
    group: item.category || item.sourceName,
    rokuGroup: item.rokuCategory || rokuText(item.sourceName),
  }));
}

app.get('/api/roku/movies', async (req, res) => {
  try {
    const pageInfo = rokuPage(req, rokuMoviePageLimit);
    // Roku movie pages are deliberately fixed at ten items per request.
    pageInfo.limit = rokuMoviePageLimit;
    pageInfo.offset = pageInfo.page * pageInfo.limit;
    const selected = (await getAllXtreamItems('movie', requestAccountOwner(req)))
      .slice()
      .sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
    const sourcePage = selected.slice(pageInfo.offset, pageInfo.offset + pageInfo.limit);
    const items = await buildXtreamMoviesPayload({ selected: sourcePage });
    res.json({
      items,
      page: pageInfo.page,
      limit: pageInfo.limit,
      total: selected.length,
      hasMore: pageInfo.offset + sourcePage.length < selected.length,
    });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/playback/history', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.set('Cache-Control', 'no-store');
    const items = await getPlaybackHistory(ownerId);
    res.json({ items: items.map((item) => ({ ...item, rokuTitle: rokuText(item.title) })) });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

async function capturePlaybackPreview(inputUrl, key, identity, kind = 'channel', position = 0) {
  const { job } = await mediaJobs.getOrCreate({
    key,
    // A one-frame JPEG is short-lived and has its own concurrency limit. Do
    // not reject it merely because Render's host load blocks long transcodes.
    mode: 'snapshot',
    persistent: false,
    // Preview captures must not consume the device's one active playback slot.
    ...identity, userId: '', deviceId: '',
  }, async () => {
    const args = ['-hide_banner', '-loglevel', 'error'];
    const { width, height } = previewFrameSize();
    args.push(
      ...previewInputArgs(kind, position),
      // Same extensionless-segment fix as hlsInputArgs() - many live-channel
      // providers fail this ffmpeg build's HLS segment-extension check. It is
      // an HLS-demuxer option, so never pass it to MP4/MKV VOD previews.
      ...(kind === 'channel' ? hlsExtensionAllowlistArgs() : []),
      '-i', inputUrl,
      '-an', '-sn', '-frames:v', '1',
      '-vf', `${kind === 'channel' ? "select='gte(n,2)'," : ''}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      '-pix_fmt', 'yuvj420p', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    );
    const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const created = { child, error: '', stop: () => terminateChild(child) };
    created.result = new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      const timeout = setTimeout(() => child.kill('SIGKILL'), 17_000);
      timeout.unref?.();
      child.stdout.on('data', chunk => {
        total += chunk.length;
        if (total <= 5 * 1024 * 1024) chunks.push(chunk);
        else child.kill('SIGKILL');
      });
      child.stderr.on('data', chunk => { created.error = appendTail(created.error, chunk); });
      child.once('error', reject);
      child.once('close', code => {
        clearTimeout(timeout);
        created.finished = true;
        if (code === 0 && total > 0 && total <= 5 * 1024 * 1024) resolve(Buffer.concat(chunks));
        else reject(new Error(created.error.trim().slice(-300) || `ffmpeg exited with ${code}`));
      });
    });
    return created;
  });
  try { return await job.result; }
  finally { await mediaJobs.remove(key, 'preview-complete'); }
}

app.get('/api/playback/preview', async (req, res) => {
  let previewJobKey = '';
  const cancelPreview = () => { if (previewJobKey) mediaJobs.remove(previewJobKey, 'client-disconnect').catch(() => {}); };
  res.once('close', cancelPreview);
  try {
    const requestedSourceId = String(req.query?.sourceId || '');
    const requestedKind = String(req.query?.kind || '');
    const requestedId = String(req.query?.id || '');
    // Snapshot previews are Live-TV-only. Roku VOD scrubbing displays only
    // its authoritative target-time bar and never opens a competing provider
    // connection for JPEG extraction.
    if (requestedKind !== 'channel') return res.status(400).json({ error: 'Preview frames are available only for live channels' });
    if (!requestedSourceId || !requestedId) return res.status(400).json({ error: 'sourceId and media id are required' });
    const target = { sourceId: requestedSourceId, kind: requestedKind, id: requestedId, extension: String(req.query?.ext || 'm3u8') };
    const previewTicket = resolveStreamTicket(requestStreamTicket(req), target.sourceId, target.kind, target.id);
    const source = await getXtreamSource(target.sourceId, previewTicket?.accountOwnerId || requestAccountOwner(req));
    if (!source) return res.sendStatus(404);
    const position = Math.floor(Date.now() / 30_000);
    const cacheKey = `${target.sourceId}:${target.kind}:${target.id}:${target.extension}:${position}`;
    evictPreviewCache();
    let frame = previewCache.get(cacheKey)?.frame;
    if (!frame) {
      const identity = mediaIdentity(req);
      const superseded = [];
      for (const [jobKey, job] of mediaJobs.entries()) {
        if (isSnapshotSupersededForViewer(job, identity)) superseded.push(mediaJobs.remove(jobKey, 'superseded-preview'));
      }
      if (superseded.length) await Promise.allSettled(superseded);
      previewJobKey = `preview:${createHash('sha256').update(cacheKey).digest('hex').slice(0, 24)}`;
      frame = await capturePlaybackPreview(await sourceProviderUrl(source, target.kind, target.id, target.extension), previewJobKey, identity, target.kind, position);
      cachePreview(cacheKey, frame, 30_000);
    }
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=30', 'Content-Length': String(frame.length) });
    res.end(frame);
  } catch (error) {
    console.warn(`[Playback preview] ${error.message}`);
    if (!res.headersSent && !res.destroyed && !capacityResponse(res, error)) res.status(502).json({ error: 'Could not capture the playback frame' });
  } finally { res.off('close', cancelPreview); }
});
app.get('/api/favorites', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.set('Cache-Control', 'no-store'); res.json({ items: await getFavorites(ownerId) });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});
async function toggleFavoriteRequest(req, res) {
  try {
    const id = String(req.query?.id || req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.json(await toggleFavorite({ ownerId, id, title: req.query?.title || req.body?.title, kind: req.query?.kind || req.body?.kind }));
  } catch (error) { res.status(500).json({ error: error.message }); }
}
app.post('/api/favorites/toggle', toggleFavoriteRequest);
app.put('/api/favorites/toggle', toggleFavoriteRequest);
app.get('/api/favorites/toggle', toggleFavoriteRequest);
app.get('/api/playback/roku/get', async (req, res) => {
  try {
    const itemId = String(req.query?.itemId || '');
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.set('Cache-Control', 'no-store');
    res.json({ item: await getPlayback(ownerId, itemId) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.put('/api/playback/roku/save', async (req, res) => {
  try {
    const itemId = String(req.query?.itemId || req.body?.itemId || '');
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const completedValue = String(req.query?.completed ?? req.body?.completed ?? 'false').toLowerCase();
    const payload = {
      ownerId, itemId,
      title: String(req.query?.title ?? req.body?.title ?? ''),
      kind: String(req.query?.kind ?? req.body?.kind ?? ''),
      poster: String(req.query?.poster ?? req.body?.poster ?? ''),
      source: String(req.query?.source ?? req.body?.source ?? 'roku'),
      position: Number(req.query?.position ?? req.body?.position ?? 0),
      duration: Number(req.query?.duration ?? req.body?.duration ?? 0),
      completed: completedValue === 'true' || completedValue === '1',
    };
    const item = await savePlayback(payload);
    console.log(`[Roku playback] saved ${redactSensitiveUrl(itemId)} at ${item.position}s`);
    res.json({ item });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/playback/:itemId', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.json({ item: await getPlayback(ownerId, String(req.params.itemId)) });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/playback/get', async (req, res) => {
  try {
    const itemId = String(req.body?.itemId || '');
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.json({ item: await getPlayback(ownerId, itemId) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.put('/api/playback/:itemId', async (req, res) => {
  try {
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    const item = await savePlayback({ ownerId, itemId: String(req.params.itemId), ...req.body });
    res.json({ item });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.put('/api/playback', async (req, res) => {
  try {
    const itemId = String(req.body?.itemId || '');
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    const ownerId = requestOwner(req);
    if (!ownerId) return res.status(401).json({ error: 'Authentication required' });
    res.json({ item: await savePlayback({ ownerId, itemId, ...req.body }) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/roku/weather-locations/search', async (req, res) => {
  try {
    const name = String(req.query.q || '').trim();
    if (name.length < 2) return res.status(400).json({ error: 'Enter at least two characters' });
    const language = String(req.query.language || 'en').toLowerCase() === 'ar' ? 'ar' : 'en';
    const query = new URLSearchParams({ name, count: '100', language, format: 'json' });
    const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${query}`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Geocoding HTTP ${response.status}`);
    const payload = await response.json();
    const locations = (payload.results || []).map(location => ({
      id: location.id,
      name: location.name,
      country: location.country || '',
      admin1: location.admin1 || '',
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: location.timezone || 'auto',
      label: [location.name, location.admin1, location.country].filter(Boolean).join(', '),
    }));
    res.json({ locations });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/roku/dashboard', async (req, res) => {
  try {
    const locations = [1].map(slot => ({
      id: 'slot1',
      label: String(req.query[`label${slot}`] || '').trim(),
      latitude: Number(req.query[`latitude${slot}`]),
      longitude: Number(req.query[`longitude${slot}`]),
      timezone: String(req.query[`timezone${slot}`] || 'auto'),
    })).filter(location => location.label && Number.isFinite(location.latitude) && Number.isFinite(location.longitude));
    const cacheKey = JSON.stringify(locations);
    const cached = dashboardCache.get(cacheKey);
    if (cached?.expires > Date.now()) return res.json(freshDashboardTimes(cached.data));
    const cities = await Promise.all(locations.map(async (location) => {
      const query = new URLSearchParams({
        latitude: location.latitude, longitude: location.longitude,
        current: 'temperature_2m,weather_code', timezone: location.timezone,
      });
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
      const data = await response.json();
      return { id: location.id, label: location.label, timezone: location.timezone, time: data.current?.time || '', temperature: data.current?.temperature_2m, weatherCode: data.current?.weather_code };
    }));
    const entry = { expires: Date.now() + 120_000, data: { backend: 'online', cities } };
    dashboardCache.set(cacheKey, entry);
    res.json(freshDashboardTimes(entry.data));
  } catch (error) { res.status(502).json({ backend: 'online', error: error.message }); }
});
function parsePlaylistInput(body, existing = null) {
  const name = String(body?.name || existing?.name || '').trim();
  const type = body?.type === 'm3u' ? 'm3u' : body?.type === 'xtream' ? 'xtream' : sourceType(existing);
  const supplied = String(body?.url || '').trim();
  if (!name) throw new Error('Source name is required');
  if (!supplied && existing) return { name };
  if (!supplied) throw new Error(`Paste the ${type === 'm3u' ? 'M3U playlist' : 'Xtream server'} URL`);
  let url;
  try { url = new URL(supplied); } catch { throw new Error('Enter a valid playlist URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Playlist URL must use HTTP or HTTPS');
  if (type === 'm3u') return { name, type, baseUrl: url.toString(), username: '', password: '' };
  const username = String(body?.username || url.searchParams.get('username') || existing?.username || '').trim();
  const password = String(body?.password || url.searchParams.get('password') || existing?.password || '').trim();
  if (!username || !password) throw new Error('Xtream username and password are required');
  const pathname = url.pathname.replace(/\/(?:get|player_api)\.php\/?$/i, '').replace(/\/$/, '');
  return { name, type, baseUrl: `${url.protocol}//${url.host}${pathname}`, username, password };
}

app.get('/api/xtream/sources', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    res.json({ items: (await getAllXtreamSources(accountOwner)).map(source => publicXtreamSource(source, ownerId, accountOwner)) });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

// Provider channel logos are often published over HTTP.  The Render frontend
// is HTTPS, so browsers block those images as mixed content.  Serve the small
// logo through this HTTPS backend endpoint instead.
app.get('/api/xtream/logo', async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Logo request timed out')), 10_000);
  timeout.unref?.();
  const abort = () => controller.abort(new Error('Logo client disconnected'));
  res.once('close', abort);
  try {
    const supplied = String(req.query.url || '').trim();
    const target = new URL(supplied);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported logo URL');
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(target.hostname)) throw new Error('Unsupported logo host');

    const response = await fetch(target, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) return res.sendStatus(response.status === 404 ? 404 : 502);
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.toLowerCase().startsWith('image/')) return res.status(415).send('Logo is not an image');
    const maxBytes = 5 * 1024 * 1024;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) { await response.body?.cancel(); return res.status(413).send('Logo is too large'); }
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes <= maxBytes ? null : new Error('Logo is too large'), chunk);
      },
    });
    res.set('Content-Type', contentType.split(';', 1)[0]);
    res.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    if (!response.body) return res.end();
    await pipeline(Readable.fromWeb(response.body), limiter, res);
  } catch (error) {
    if (!res.headersSent && !res.destroyed) res.status(error.message === 'Logo is too large' ? 413 : 400).send(error.message || 'Invalid logo URL');
  } finally {
    clearTimeout(timeout);
    res.off('close', abort);
  }
});

app.post('/api/xtream/sources', async (req, res) => {
  try {
    const source = parsePlaylistInput(req.body);
    if (source.type === 'm3u') await validateM3uConnection({ ...source, _id: 'validation' });
    else await validateXtreamConnection({ ...source, _id: 'validation' });
    res.status(201).json(await createXtreamSource({ ...source, ownerId: requestAccountOwner(req) }));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/xtream/sources/:id', async (req, res) => {
  try {
    const existing = await getXtreamSource(req.params.id, requestAccountOwner(req));
    if (!existing) return res.sendStatus(404);
    const changes = parsePlaylistInput(req.body, existing);
    if (changes.baseUrl) {
      const candidate = { ...existing, ...changes };
      if (sourceType(candidate) === 'm3u') await validateM3uConnection(candidate);
      else await validateXtreamConnection(candidate);
    }
    res.json(await updateXtreamSource(req.params.id, changes, requestAccountOwner(req)));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/xtream/sources/:id', async (req, res) => {
  try {
    if (!await deleteXtreamSource(req.params.id, requestAccountOwner(req))) return res.sendStatus(404);
    res.sendStatus(204);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/xtream/catalog', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    const source = await getXtreamSource(String(req.query.sourceId || ''), accountOwner);
    if (!source) return res.status(404).json({ error: 'Xtream source not found' });
    const aliases = { live: 'channel', channel: 'channel', movie: 'movie', vod: 'movie', series: 'series' };
    const kind = aliases[String(req.query.kind || '')];
    if (!kind) return res.status(400).json({ error: 'kind must be channel, movie, or series' });
    const [allItems, categories] = await Promise.all([getSourceCatalog(source, kind), getSourceCategories(source, kind)]);
    const selectedSource = { ...source, ...selectionFor(source, ownerId, accountOwner) };
    const enabled = new Set(selectedSource.enabledKeys);
    const query = String(req.query.q || '').trim().toLocaleLowerCase();
    const normalizedQuery = normalizeArabicSearch(query);
    const category = String(req.query.category || 'all');
    const titleLanguage = String(req.query.titleLanguage || req.query.language || 'all').toUpperCase();
    const pageSize = Math.min(200, Math.max(10, Number.parseInt(req.query.limit, 10) || 50));
    const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const languagePriority = { AR: 0, EN: 1 };
    const languageSet = new Set();
    const filtered = [];
    for (const item of allItems) {
      const languageCode = titleLanguageCode(item);
      languageSet.add(languageCode);
      if ((category === 'all' || item.categoryId === category)
        && (titleLanguage === 'ALL' || languageCode === titleLanguage)
        && (!query || normalizeArabicSearch(item.title).includes(normalizedQuery))) {
        filtered.push({ ...item, languageCode, titleLanguage: languageCode });
      }
    }
    const languages = [...languageSet]
      .sort((a, b) => (languagePriority[a] ?? 10) - (languagePriority[b] ?? 10) || a.localeCompare(b));
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(requestedPage, pageCount);
    const start = (page - 1) * pageSize;
    res.json({
      source: publicXtreamSource(source, ownerId, accountOwner), categories, languages,
      items: filtered.slice(start, start + pageSize).map(item => ({ ...item, enabled: enabled.has(item.key) })),
      pagination: { page, pageSize, pageCount, total: filtered.length },
    });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

async function resolveXtreamEnabledItems(source, enabledKeys) {
    const allowed = enabledKeys.map(String).filter(key => /^(channel|movie|series):[^:]+$/.test(key));
    const allowedSet = new Set(allowed);
    const kinds = [...new Set(allowed.map(key => key.split(':', 1)[0]))];
    const [catalogs, categoryGroups] = await Promise.all([
      Promise.all(kinds.map(kind => getSourceCatalog(source, kind))),
      Promise.all(kinds.map(kind => getSourceCategories(source, kind))),
    ]);
    const categoryNamesByKind = new Map(kinds.map((kind, index) => [
      kind, new Map(categoryGroups[index].map(category => [category.id, category.name])),
    ]));
    const resolved = catalogs.flat().filter(item => allowedSet.has(item.key));
    const byKey = new Map(resolved.map(item => [item.key, item]));
    return allowed.map(key => byKey.get(key)).filter(Boolean).map(item => ({
      key: item.key,
      id: item.id,
      kind: item.kind,
      title: item.title,
      logo: item.logo,
      categoryId: item.categoryId,
      category: categoryNamesByKind.get(item.kind)?.get(item.categoryId) || 'Other',
      language: detectXtreamLanguage(item, categoryNamesByKind.get(item.kind)?.get(item.categoryId) || 'Other'),
      extension: item.extension,
      duration: item.duration,
      added: item.added,
    }));
}

function suppliedXtreamEnabledItems(source, enabledKeys, suppliedItems, categoryNamesByKind = new Map()) {
  if (!Array.isArray(suppliedItems)) return [];
  const allowed = enabledKeys.map(String).filter(key => /^(channel|movie|series):[^:]+$/.test(key));
  const suppliedByKey = new Map(suppliedItems
    .filter(item => item && typeof item === 'object' && allowed.includes(String(item.key)))
    .map(item => [String(item.key), item]));
  return allowed.map(key => {
    const item = suppliedByKey.get(key);
    if (!item) return null;
    const [kind, id] = key.split(':', 2);
    const category = categoryNamesByKind.get(kind)?.get(String(item.categoryId || ''))
      || (String(item.category || '').trim() && String(item.category).trim() !== source.name ? String(item.category).trim() : '')
      || 'Other';
    return {
      key,
      id: String(item.id || id),
      kind,
      title: String(item.title || `${kind} ${id}`),
      logo: String(item.logo || ''),
      categoryId: String(item.categoryId || ''),
      category,
      language: String(item.language || detectXtreamLanguage(item, category)),
      extension: String(item.extension || (kind === 'channel' ? 'm3u8' : 'mp4')),
      duration: String(item.duration || ''),
      added: String(item.added || ''),
    };
  }).filter(Boolean);
}

app.get('/api/xtream/sources/:id/enabled', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    const source = await getXtreamSource(req.params.id, accountOwner);
    if (!source) return res.sendStatus(404);
    const selectedSource = { ...source, ...selectionFor(source, ownerId, accountOwner) };
    const enabledKeys = selectedSource.enabledKeys;
    let enabledItems = selectedSource.enabledItems;
    const itemKeys = new Set(enabledItems.map(item => item.key));
    const needsBackfill = enabledItems.length !== enabledKeys.length
      || enabledKeys.some(key => !itemKeys.has(key))
      || enabledItems.some(item => !item.category || !item.language
        || String(item.category).trim().toLowerCase() === String(source.name).trim().toLowerCase());
    if (needsBackfill && enabledKeys.length) {
      enabledItems = await resolveXtreamEnabledItems(source, enabledKeys);
      const updated = await updateXtreamSelection(source._id, { ...selectionFor(source, ownerId, accountOwner), enabledKeys: enabledItems.map(item => item.key), enabledItems }, accountOwner, ownerId);
      return res.json({ source: updated, items: updated.enabledItems });
    }
    res.json({ source: publicXtreamSource(source, ownerId, accountOwner), items: enabledItems });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.put('/api/xtream/sources/:id/selection', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.enabledKeys)) return res.status(400).json({ error: 'enabledKeys must be an array' });
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    const source = await getXtreamSource(req.params.id, accountOwner);
    if (!source) return res.sendStatus(404);
    const selectedSource = { ...source, ...selectionFor(source, ownerId, accountOwner) };
    // The manager already has the selected catalog rows. Persist them directly
    // instead of downloading every Xtream list again merely to resolve keys.
    // Full provider catalog reloads here were causing browser "Failed to fetch"
    // after Render ran out of memory or timed out.
    const kinds = [...new Set(req.body.enabledKeys.map(String)
      .map(key => key.split(':', 1)[0])
      .filter(kind => ['channel', 'movie', 'series'].includes(kind)))];
    const categoryGroups = await Promise.all(kinds.map(kind => getSourceCategories(source, kind)));
    const categoryNamesByKind = new Map(kinds.map((kind, index) => [
      kind,
      new Map(categoryGroups[index].map(category => [String(category.id), category.name])),
    ]));
    const enabledItems = suppliedXtreamEnabledItems(source, req.body.enabledKeys, req.body.enabledItems, categoryNamesByKind);
    if (enabledItems.length !== req.body.enabledKeys.length) {
      return res.status(400).json({ error: 'Selected item details are missing. Reload the catalog and try again.' });
    }
    const enabledKeys = enabledItems.map(item => item.key);
    const enabledSet = new Set(enabledKeys);
    const updated = await updateXtreamSource(req.params.id, {
      enabledKeys,
      enabledItems,
      archivedKeys: selectedSource.archivedKeys.filter(key => !enabledSet.has(key)),
      archivedItems: selectedSource.archivedItems.filter(item => !enabledSet.has(item.key)),
    }, accountOwner, ownerId);
    if (!updated) return res.sendStatus(404);
    res.json(updated);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/xtream/sources/:id/archive/:key', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    const source = await getXtreamSource(req.params.id, accountOwner);
    if (!source) return res.sendStatus(404);
    const selectedSource = { ...source, ...selectionFor(source, ownerId, accountOwner) };
    const key = String(req.params.key || '');
    const enabledItems = selectedSource.enabledItems;
    const item = enabledItems.find(candidate => candidate.key === key);
    if (!item) return res.status(404).json({ error: 'Saved Roku item not found' });
    const archiveItems = [...selectedSource.archivedItems.filter(candidate => candidate.key !== key), item];
    const updated = await updateXtreamSelection(source._id, {
      enabledKeys: selectedSource.enabledKeys.filter(candidate => candidate !== key),
      enabledItems: enabledItems.filter(candidate => candidate.key !== key),
      archivedKeys: archiveItems.map(candidate => candidate.key),
      archivedItems: archiveItems,
    }, accountOwner, ownerId);
    res.json(updated);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/xtream/sources/:id/archive/:key/restore', async (req, res) => {
  try {
    const ownerId = requestOwner(req), accountOwner = requestAccountOwner(req);
    const source = await getXtreamSource(req.params.id, accountOwner);
    if (!source) return res.sendStatus(404);
    const selectedSource = { ...source, ...selectionFor(source, ownerId, accountOwner) };
    const key = String(req.params.key || '');
    const archivedItems = selectedSource.archivedItems;
    const item = archivedItems.find(candidate => candidate.key === key);
    if (!item) return res.status(404).json({ error: 'Archived item not found' });
    const enabledItems = [...selectedSource.enabledItems.filter(candidate => candidate.key !== key), item];
    const updated = await updateXtreamSelection(source._id, {
      enabledKeys: enabledItems.map(candidate => candidate.key),
      enabledItems,
      archivedKeys: selectedSource.archivedKeys.filter(candidate => candidate !== key),
      archivedItems: archivedItems.filter(candidate => candidate.key !== key),
    }, accountOwner, ownerId);
    res.json(updated);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// A Roku ECP launch is a true handoff: stop only the Android player's exact
// backend job and wait for its provider lease to close before Roku asks for
// the same item. Roku device playback has a different viewer identity, so
// later Android navigation cannot stop a stream already owned by Roku.
app.post('/api/xtream/playback/release', async (req, res) => {
  try {
    const sourceId = String(req.body?.sourceId || '').trim();
    const kind = String(req.body?.kind || '').trim();
    const id = String(req.body?.id || '').trim();
    const extension = String(req.body?.extension || '').trim();
    if (!sourceId || !['channel', 'movie', 'series'].includes(kind) || !id) {
      return res.status(400).json({ error: 'sourceId, kind, and id are required' });
    }
    const identity = mediaIdentity(req);
    let stopped = 0;
    for (const [key, job] of [...mediaJobs.entries()]) {
      if (job.wwpSessionId || String(job.sourceId) !== sourceId || job.kind !== kind
          || String(job.mediaId) !== id || !samePlaybackViewer(job, identity)) continue;
      if (await mediaJobs.remove(key, 'android-roku-handoff')) stopped += 1;
    }
    const nativeKey = rokuHlsKey(sourceId, 'channel', id, extension, 0);
    if (nativeHlsSessions.get(nativeKey)?.viewerId === identity.viewerId) nativeHlsSessions.delete(nativeKey);
    res.set('Cache-Control', 'no-store');
    res.json({ stopped });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Direct playback means the client (Roku/Android/browser) talks to the
// provider itself. This route only resolves which URL that is and redirects
// - it does not proxy bytes, gate on a codec pre-check, or hold a provider
// concurrency lease. The client's own player is the real arbiter of whether
// the provider's file is playable, and each client already falls back to the
// compatibility-selected HLS pipeline on a Direct error/timeout. Roku's own
// catalog now embeds the provider URL directly (see selectedXtreamItem /
// buildXtreamSeriesPayload) and never calls this route at all; it stays here
// only for Android/browser, which still request this exact path.
app.get('/api/xtream/play/:sourceId/:kind/:id', async (req, res) => {
  try {
    const mediaTicket = resolveStreamTicket(requestStreamTicket(req), req.params.sourceId, req.params.kind, req.params.id);
    const source = await getXtreamSource(req.params.sourceId, mediaTicket?.accountOwnerId || requestAccountOwner(req));
    if (!source) return res.sendStatus(404);
    if (!['channel', 'movie', 'series'].includes(req.params.kind)) return res.sendStatus(400);
    const target = playbackTarget(req);
    console.log(`[Media Direct] ${req.params.kind}:${req.params.id} redirecting to provider ext=${String(req.query.ext || '') || 'unknown'} client=${target.client}`);
    res.redirect(302, await sourceProviderUrl(source, req.params.kind, req.params.id, req.query.ext));
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      if (!capacityResponse(res, error)) res.status(502).json({ error: 'The provider could not start this stream.' });
    } else if (!res.destroyed) res.destroy(error);
  }
});

// Android public-network DIRECT: relay the provider's original response bytes
// unchanged through the RH HTTPS streamer. This is not HLS, remux, or
// transcode. Android supplies its exact transient cached providerURL; the
// server neither reconstructs nor persists it. Range requests are preserved
// so Media3 can seek progressive VOD normally.
app.get('/api/xtream/direct/:sourceId/:kind/:id', async (req, res) => {
  const controller = new AbortController();
  const abortUpstream = () => controller.abort(new Error('Direct client disconnected'));
  res.once('close', abortUpstream);
  let releaseDirectStream;
  let headerTimeout;
  try {
    if (!['channel', 'movie', 'series'].includes(req.params.kind)) return res.sendStatus(400);
    const mediaTicket = resolveStreamTicket(requestStreamTicket(req), req.params.sourceId, req.params.kind, req.params.id);
    const source = await getXtreamSource(req.params.sourceId, mediaTicket?.accountOwnerId || requestAccountOwner(req));
    if (!source) return res.sendStatus(404);
    const inputUrl = await requestProviderUrl(req, source, req.params.kind, req.params.id, req.query.ext);
    releaseDirectStream = directStreamLimiter.acquire(req.params.sourceId);
    const headers = { 'user-agent': req.headers['user-agent'] || 'RH-Android/1.0', connection: 'close' };
    // Media3's first progressive request does not consistently include Range.
    // Some Xtream providers delay a whole-file response for tens of seconds,
    // even though the same media answers an open-ended byte range immediately.
    // Start VOD as a progressive range response; preserve every client seek
    // range verbatim once Media3 supplies one.
    if (req.headers.range) headers.range = req.headers.range;
    else if (req.params.kind === 'movie' || req.params.kind === 'series') headers.range = 'bytes=0-';
    headerTimeout = setTimeout(() => controller.abort(new Error('Provider Direct response timed out')), 15_000);
    headerTimeout.unref?.();
    const upstream = await fetch(inputUrl, { headers, redirect: 'follow', signal: controller.signal });
    clearTimeout(headerTimeout);
    headerTimeout = null;
    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => {});
      console.warn(`[Media Direct relay] ${req.params.kind}:${req.params.id} provider status=${upstream.status}`);
      return res.sendStatus(upstream.status || 502);
    }
    for (const name of ['content-length', 'content-range', 'content-type', 'etag', 'last-modified', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-RH-Strategy', 'DIRECT');
    res.status(upstream.status);
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    console.warn(`[Media Direct relay] ${req.params.kind}:${req.params.id} failed: ${error.message}`);
    if (!res.headersSent && !res.destroyed && !capacityResponse(res, error)) {
      res.status(error.name === 'AbortError' ? 504 : 502).json({ error: error.message });
    }
  } finally {
    if (headerTimeout) clearTimeout(headerTimeout);
    releaseDirectStream?.();
    res.off('close', abortUpstream);
  }
});

function hlsStartSeconds(value) {
  // Keep tenth-of-a-second precision so a resume-after-interruption lands on
  // (near) the exact frame it stopped at, not the start of a 2s segment. The
  // ffmpeg -ss below is an accurate seek, so the output really does begin at
  // this timestamp. Rounded to 0.1s to keep the job cache key from exploding.
  const parsed = Math.round((Number(value) || 0) * 10) / 10;
  return Math.min(7 * 24 * 60 * 60, Math.max(0, parsed));
}

function evictNativeHlsSessions(now = Date.now()) {
  for (const [key, session] of nativeHlsSessions) if (session.expiresAt <= now) nativeHlsSessions.delete(key);
  while (nativeHlsSessions.size > nativeHlsSessionMaxEntries) nativeHlsSessions.delete(nativeHlsSessions.keys().next().value);
}

function nativeHlsSession(req, identity, create = false) {
  evictNativeHlsSessions();
  const key = rokuHlsKey(req.params.sourceId, 'channel', req.params.id, req.query.ext, 0);
  let session = nativeHlsSessions.get(key);
  if (session && session.userId && session.userId !== identity.userId) session = null;
  if (!session && create) {
    session = {
      key,
      userId: identity.userId,
      viewerId: identity.viewerId,
      resources: new Map(),
      manifests: new Map(),
      resourceBodies: new Map(),
      timelineSequences: new Map(),
      nextTimelineSequence: 0,
      cacheBust: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      expiresAt: Date.now() + nativeHlsSessionTtlMs,
    };
    nativeHlsSessions.set(key, session);
    evictNativeHlsSessions();
  }
  if (session) {
    session.expiresAt = Date.now() + nativeHlsSessionTtlMs;
    nativeHlsSessions.delete(key);
    nativeHlsSessions.set(key, session);
  }
  return session;
}

function nativeHlsResourcePath(req, session, upstreamUrl) {
  const id = hlsResourceId(upstreamUrl);
  session.resources.delete(id);
  session.resources.set(id, upstreamUrl);
  while (session.resources.size > 512) session.resources.delete(session.resources.keys().next().value);
  const childQuery = hlsChildRequestQuery(req.query, 0);
  childQuery.set('liveSession', session.cacheBust);
  const query = childQuery.toString();
  const base = `/api/xtream/hls/${encodeURIComponent(req.params.sourceId)}/channel/${encodeURIComponent(req.params.id)}/resource/${id}`;
  return query ? `${base}?${query}` : base;
}

function preferStableAndroidLiveStart(manifest, firstSegmentIndex = 0) {
  const text = String(manifest || '');
  if (!text.startsWith('#EXTM3U')) return text;
  const lines = text.split('\n');
  const extinf = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].startsWith('#EXTINF:')) extinf.push(index);
  }
  const selected = Math.max(0, Math.min(extinf.length - 1, Number(firstSegmentIndex) || 0));
  let stable = text;
  if (selected > 0 && extinf.length > selected) {
    stable = [...lines.slice(0, extinf[0]), ...lines.slice(extinf[selected])].join('\n');
    stable = stable.replace(/#EXT-X-MEDIA-SEQUENCE:(\d+)/, (_line, value) =>
      `#EXT-X-MEDIA-SEQUENCE:${Number(value) + selected}`);
  }
  stable = stable.replace(/^#EXT-X-START:.*\n?/m, '');
  // Several providers cut their three-second TS segments mid-GOP and repeat
  // SPS/PPS only every few segments. Media3's normal near-edge selection can
  // therefore begin on a segment that has samples but no format declaration,
  // triggering SampleQueue's checkStateNotNull and a reconnect loop. The
  // oldest segment in the rolling provider window is the safest complete GOP
  // boundary and also gives Android enough real media to absorb relay jitter.
  return stable.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=NO');
}

function hasDecodableVideoStart(body) {
  let h264Sps = false, h264Pps = false, h264Idr = false;
  let hevcVps = false, hevcSps = false, hevcPps = false, hevcIdr = false;
  let h264SamplesBeforeFormat = false, hevcSamplesBeforeFormat = false;
  for (let index = 0; index + 5 < body.length; index++) {
    let nal = -1;
    if (body[index] === 0 && body[index + 1] === 0 && body[index + 2] === 1) nal = body[index + 3];
    else if (body[index] === 0 && body[index + 1] === 0 && body[index + 2] === 0 && body[index + 3] === 1) nal = body[index + 4];
    if (nal < 0) continue;
    const h264Type = nal & 0x1f;
    if (h264Type === 7) h264Sps = true;
    else if (h264Type === 8) h264Pps = true;
    else if (h264Type >= 1 && h264Type <= 5) {
      if (!h264Sps || !h264Pps) h264SamplesBeforeFormat = true;
      if (h264Type === 5) h264Idr = true;
    }
    const hevcType = (nal >> 1) & 0x3f;
    if (hevcType === 32) hevcVps = true;
    else if (hevcType === 33) hevcSps = true;
    else if (hevcType === 34) hevcPps = true;
    else if (hevcType <= 31) {
      if (!hevcVps || !hevcSps || !hevcPps) hevcSamplesBeforeFormat = true;
      if (hevcType === 19 || hevcType === 20) hevcIdr = true;
    }
    if (!h264SamplesBeforeFormat && h264Sps && h264Pps && h264Idr) return true;
    if (!hevcSamplesBeforeFormat && hevcVps && hevcSps && hevcPps && hevcIdr) return true;
  }
  return false;
}

function normalizeNativeHlsTimeline(manifest, manifestUrl, session) {
  const text = String(manifest || '');
  const urls = text.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'))
    .map(line => new URL(line.trim(), manifestUrl).toString());
  if (!urls.length) return text;
  const identities = urls.map(url => {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  });
  let firstSequence = -1;
  for (let index = 0; index < identities.length; index++) {
    const known = session.timelineSequences.get(identities[index]);
    if (Number.isFinite(known)) { firstSequence = known - index; break; }
  }
  if (firstSequence < 0) firstSequence = session.nextTimelineSequence || 0;
  for (let index = 0; index < identities.length; index++) {
    session.timelineSequences.set(identities[index], firstSequence + index);
  }
  session.nextTimelineSequence = Math.max(session.nextTimelineSequence || 0, firstSequence + identities.length);
  while (session.timelineSequences.size > 512) {
    session.timelineSequences.delete(session.timelineSequences.keys().next().value);
  }
  if (/#EXT-X-MEDIA-SEQUENCE:\d+/m.test(text)) {
    return text.replace(/#EXT-X-MEDIA-SEQUENCE:\d+/m, `#EXT-X-MEDIA-SEQUENCE:${firstSequence}`);
  }
  return text.replace('#EXTM3U', `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${firstSequence}`);
}

async function selectStableAndroidLiveStart(manifest, manifestUrl, session, signal) {
  const lines = String(manifest).split('\n');
  const segmentUrls = lines.filter(line => line.trim() && !line.trim().startsWith('#'))
    .map(line => new URL(line.trim(), manifestUrl).toString());
  const sequence = Number(String(manifest).match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] || 0);
  if (!segmentUrls.length) return preferStableAndroidLiveStart(manifest);
  if (Number.isFinite(session.stableStartSequence)) {
    const index = session.stableStartSequence - sequence;
    if (index >= 0 && index < segmentUrls.length) return preferStableAndroidLiveStart(manifest, index);
    return manifest;
  }
  const nearEdge = Math.max(0, segmentUrls.length - 4);
  const order = [];
  for (let index = nearEdge; index >= 0 && order.length < 7; index--) order.push(index);
  for (let index = nearEdge + 1; index < segmentUrls.length && order.length < 7; index++) order.push(index);
  for (const index of order) {
    try {
      const url = segmentUrls[index];
      const prefetched = await nativeHlsResourceLocks.run(session.key, async () => {
        const response = await fetch(url, {
          headers: { 'user-agent': 'RH-Stream/1.0', connection: 'close' },
          signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
        });
        if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
        return { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'video/mp2t' };
      });
      if (!prefetched) continue;
      session.resourceBodies.set(url, prefetched);
      if (!hasDecodableVideoStart(prefetched.body)) continue;
      session.stableStartSequence = sequence + index;
      console.log(`[Native HLS] stable Android start sequence=${session.stableStartSequence} inspected=${order.indexOf(index) + 1}`);
      return preferStableAndroidLiveStart(manifest, index);
    } catch { /* inspect the next bounded candidate */ }
  }
  return preferStableAndroidLiveStart(manifest);
}

async function fetchNativeHlsManifest(upstreamUrl, session, signal) {
  return nativeHlsResourceLocks.run(session.key, async () => {
    const response = await fetch(upstreamUrl, {
      headers: { 'user-agent': 'RH-Stream/1.0', connection: 'close' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Native HLS manifest returned HTTP ${response.status}`);
    }
    const manifest = await response.text();
    const manifestUrl = response.url || upstreamUrl;
    if (!isHlsManifest(response.headers.get('content-type'), manifestUrl, manifest)) throw new Error('Provider did not return an HLS manifest');
    // fetch follows redirects. Relative HLS child URIs are relative to the
    // final response URL, which some providers move to a different host/port.
    return { manifest, manifestUrl };
  });
}

async function serveNativeHlsManifest(req, res, upstreamUrl, session, signal) {
  let manifest;
  let manifestUrl = upstreamUrl;
  try {
    ({ manifest, manifestUrl } = await fetchNativeHlsManifest(upstreamUrl, session, signal));
  } catch (error) {
    const cached = session.manifests?.get(upstreamUrl);
    if (!cached) throw error;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-RH-Strategy', 'DIRECT');
    res.setHeader('X-RH-Video-Mode', 'copy');
    res.send(cached);
    return;
  }
  session.rootUrl = upstreamUrl;
  session.expiresAt = Date.now() + nativeHlsSessionTtlMs;
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  // Native HLS is a provider-byte passthrough. Android uses this so its
  // connection only needs to reach RH; every provider segment URI is rewritten
  // to the authenticated RH resource relay, with no FFmpeg/transcoding.
  res.setHeader('X-RH-Strategy', 'DIRECT');
  res.setHeader('X-RH-Video-Mode', 'copy');
  if (!hasHlsVariants(manifest)) {
    // Android's Media3 accepts a media playlist as the root HLS response.
    // Rewriting it in place avoids a synthetic master -> resource round trip,
    // which could lose the in-memory resource mapping and return a 404 before
    // playback ever reached the first provider segment.
    const normalizedManifest = normalizeNativeHlsTimeline(manifest, manifestUrl, session);
    const stableManifest = await selectStableAndroidLiveStart(normalizedManifest, manifestUrl, session, signal);
    const responseManifest = rewriteHlsManifest(stableManifest, manifestUrl, url => nativeHlsResourcePath(req, session, url));
    session.manifests.set(upstreamUrl, responseManifest);
    res.send(responseManifest);
    return;
  }
  const rewritten = rewriteHlsManifest(manifest, manifestUrl, url => nativeHlsResourcePath(req, session, url));
  const responseManifest = normalizeHlsMasterForRoku(rewritten);
  session.manifests.set(upstreamUrl, responseManifest);
  res.send(responseManifest);
}

async function waitForHlsManifest(filename, timeoutMs = 15_000, signal, isFinished = () => false, requiredSegments = 1) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw signal.reason || new Error('Manifest request cancelled');
    try {
      const manifest = await fs.readFile(filename, 'utf8');
      const segmentCount = manifest.split('\n').filter(line => /^segment-\d{6}\.ts$/.test(line.trim())).length;
      // A deep restart at the end of a VOD may legitimately contain only its
      // final short segment. ENDLIST makes that one segment a complete,
      // playable response; waiting for the normal three-segment startup
      // cushion can never succeed and makes Roku loop forever at 13%.
      if (segmentCount >= requiredSegments || (segmentCount > 0 && manifest.includes('#EXT-X-ENDLIST'))) return true;
    } catch { /* ffmpeg has not produced the first segment yet */ }
    if (isFinished()) return false;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  return false;
}

async function completedHlsManifestAvailable(filename) {
  try {
    const manifest = await fs.readFile(filename, 'utf8');
    return manifest.includes('#EXT-X-ENDLIST') && /^segment-\d{6}\.ts$/m.test(manifest);
  } catch {
    return false;
  }
}

async function getOrStartRokuHls(source, kind, id, extension, requestedStart = 0, identity = {}, target = {}, strategyOverride = null, suppliedProviderURL = '') {
  return mediaSourceLocks.run(source._id, () => getOrStartRokuHlsUnlocked(source, kind, id, extension, requestedStart, identity, target, strategyOverride, suppliedProviderURL));
}

async function getOrStartRokuHlsUnlocked(source, kind, id, extension, requestedStart = 0, identity = {}, target = {}, strategyOverride = null, suppliedProviderURL = '') {
  const seekableVod = kind === 'movie' || kind === 'series';
  let startSeconds = seekableVod ? hlsStartSeconds(requestedStart) : 0;
  // A manual quality rung forks its own job even for a live channel (folding
  // target.key in), so one viewer picking 480p never disturbs another
  // viewer's Auto stream of the same channel. Auto-only channel viewers keep
  // sharing one job exactly as before (empty capabilityKey).
  const capabilityKey = identity.wwpSessionId
    ? `wwp:${identity.wwpSessionId}`
    : (seekableVod || target.maxHeight) ? String(target.key || target.client || PlaybackClient.BROWSER) : '';
  const recoveryKey = typeof strategyOverride === 'string' && strategyOverride
    ? `:hls-fallback-${strategyOverride}`
    : '';
  const keyedCapability = `${capabilityKey}${recoveryKey}`;

  // Watch with Partner: the two participants compute their own playback
  // position independently and to 0.1s precision, so every follow / poll /
  // error-recovery restart from one side carries a slightly different -ss than
  // the other's. Folding startSeconds into the job key made each such request
  // fork a near-duplicate ffmpeg job that then ping-ponged teardown with the
  // partner's - an endless restart loop that froze both players. Fix: a WWP
  // job key is keyed on the SESSION only (start excluded); a request within
  // the running job just rides it as-is. Only an explicit user seek (the
  // wwpSeek flag), a quality switch, or an obviously-broken >25s gap rebuilds -
  // so a flaky provider's endless error-recovery reloads do NOT keep forking
  // and tearing down the shared job.
  const wwpJobKey = identity.wwpSessionId && seekableVod;
  const key = wwpJobKey
    ? rokuHlsKey(source._id, kind, id, extension, 0, keyedCapability)
    : rokuHlsKey(source._id, kind, id, extension, startSeconds, keyedCapability);

  if (wwpJobKey) {
    const running = mediaJobs.get(key);
    if (running && !running.finished && running.child?.exitCode === null) {
      // wwpSeek rides every hls.js poll after one seek - so it only rebuilds
      // when the offset genuinely moved off the running job (else the shared
      // job would be torn down and rebuilt on every single manifest poll).
      const offsetMoved = Math.abs((Number(running.startSeconds) || 0) - startSeconds);
      const seek = (identity.wwpSeek && offsetMoved > 1) || offsetMoved > 25;
      const qualitySwitch = String(running.wwpQuality || '') !== String(identity.wwpQuality || '');
      if (!seek && !qualitySwitch) {
        startSeconds = Number(running.startSeconds) || 0; // ride the shared job untouched
      } else {
        await mediaJobs.remove(key, qualitySwitch ? 'wwp-quality' : 'wwp-seek'); // rebuild
      }
    }
  }

  const existing = mediaJobs.get(key);
  if (existing) {
    if (existing.finished || existing.child?.exitCode !== null) {
      // Successful VOD completion is immutable. Keep serving its ENDLIST
      // manifest while Roku drains the final segment; restarting ffmpeg here
      // turns a real EOF into an endless one-segment/13% buffering loop.
      if (seekableVod && existing.completed === true && await completedHlsManifestAvailable(existing.manifest)) {
        mediaJobs.touch(existing, identity.viewerId);
        reconcileWwpSession(identity.wwpSessionId, { key, sourceId: String(source._id), kind, id: String(id), extension: String(extension || ''), start: startSeconds, quality: identity.wwpQuality, ownerId: identity.userId, userSeek: identity.wwpSeek });
        return existing;
      }
      await mediaJobs.remove(key, 'restart-failed');
    } else {
    mediaJobs.touch(existing, identity.viewerId);
    reconcileWwpSession(identity.wwpSessionId, { key, sourceId: String(source._id), kind, id: String(id), extension: String(extension || ''), start: startSeconds, quality: identity.wwpQuality, ownerId: identity.userId, userSeek: identity.wwpSeek });
    return existing;
    }
  }

  // One player/viewer owns one active playback job. Android account tokens do
  // not always carry a linked Roku device ID, so viewer identity must also
  // replace the prior episode immediately instead of waiting for idle cleanup.
  for (const [otherKey, otherJob] of mediaJobs.entries()) {
    if (isPlaybackSupersededForViewer(otherJob, identity, key)) {
      await mediaJobs.remove(otherKey, 'replaced-viewer-playback');
    }
  }

  // Xtream accounts commonly allow only one live connection. Stop the prior
  // channel immediately when another channel is opened; otherwise the
  // provider responds with a tiny valid-but-completely-black placeholder.
  if (kind === 'channel') {
    // The focused-card snapshot opens the same provider channel. Roku can
    // select the card while that request is still decoding; wait for its
    // process to close before claiming the provider's playback connection.
    const previews = [];
    for (const [otherKey, otherJob] of mediaJobs.entries()) {
      if (isSnapshotSupersededForViewer(otherJob, identity)) previews.push(mediaJobs.remove(otherKey, 'live-playback-started'));
    }
    if (previews.length) await Promise.allSettled(previews);
    for (const [otherKey, otherJob] of mediaJobs.entries()) {
      if (otherKey === key || !otherJob.persistent || otherJob.kind !== 'channel' || otherJob.sourceId !== String(source._id) || !samePlaybackViewer(otherJob, identity)) continue;
      await mediaJobs.remove(otherKey, 'replaced-channel');
    }
  }

  // A VOD seek replaces the prior stream for that item. Keeping both jobs
  // alive wastes Render CPU/disk and can exceed a provider's connection cap.
  if (seekableVod) {
    for (const [otherKey, otherJob] of mediaJobs.entries()) {
      if (otherKey === key || !otherJob.persistent || otherJob.kind !== kind || otherJob.sourceId !== String(source._id) || otherJob.mediaId !== String(id) || !samePlaybackViewer(otherJob, identity)) continue;
      await mediaJobs.remove(otherKey, 'replaced-seek');
    }
  }

  const capacityKey = providerLeaseKey(source);

  // Android carries the exact URL from its already-fetched catalog cache.
  // Other clients retain their existing identity-based resolution behavior.
  const inputUrl = target.client === PlaybackClient.ANDROID && suppliedProviderURL
    ? suppliedProviderURL
    : await sourceProviderUrl(source, kind, id, extension);
  const providerCacheKey = `${source._id}:${kind}:${id}:${String(extension || '').toLowerCase()}:${createHash('sha256').update(inputUrl).digest('hex').slice(0, 16)}`;
  evictCodecProbeCache();
  const cachedProviderState = codecProbeCache.get(providerCacheKey)?.metadata;
  if (cachedProviderState?.providerUnavailable) {
    const error = new Error(`Playlist provider refused this title (${cachedProviderState.providerError || 'access denied'})`);
    error.statusCode = 502;
    error.providerUnavailable = true;
    throw error;
  }
  // VOD decisions come from the actual streams and the requesting player's
  // reported capability. The bounded probe cache/in-flight map prevents two
  // manifest requests from opening duplicate provider connections.
  // Probe every VOD before applying a quality ceiling. A selected rung is a
  // maximum, not an instruction to re-encode: if the source is already at or
  // below that height, preserve its compatible bitstreams with HLS remux.
  // The bounded probe cache keeps subsequent quality changes and seeks from
  // opening another provider connection.
  const metadata = seekableVod
    ? await providerCodecMetadata(providerCacheKey, inputUrl)
    : cachedProviderState || {};
  if (metadata.providerUnavailable) {
    const error = new Error(`Playlist provider refused this title (${metadata.providerError || 'access denied'})`);
    error.statusCode = 502;
    error.providerUnavailable = true;
    throw error;
  }
  if (seekableVod && Number(metadata.containerSeconds) > 0) rememberVodDuration(String(source._id), kind, String(id), metadata.containerSeconds);
  const capabilities = target.capabilities || getPlaybackCapabilities(target.client);
  const selectedDecision = seekableVod
    ? determineHlsStrategy(metadata, capabilities)
    : forceHlsFallback('full', determineHlsStrategy({ videoCodec: 'h264', audioCodec: 'aac' }, getPlaybackCapabilities(PlaybackClient.ROKU)));
  // The home focused-card preview is a short-lived compatibility stream, not
  // production VOD AUTO playback.  Provider-native manifests are frequently
  // accepted by the proxy but rejected by Roku before it requests a segment.
  // Repackage those live packets into our known-good MPEG-TS HLS profile
  // without encoding them. If stream copy cannot produce a playable segment,
  // the bounded fallback loop below still advances to full transcode.
  const previewRemux = kind === 'channel' && strategyOverride === 'preview-remux';
  const baseDecision = previewRemux
    ? forceHlsFallback('remux', selectedDecision)
    : typeof strategyOverride === 'object' && strategyOverride
      ? strategyOverride
      : forceHlsFallback(strategyOverride, selectedDecision);
  // No codec probe for live (avoids extra provider connections), so
  // sourceHeight is 0/unknown here - applyQualityCeiling always forces the
  // rung in that case, which is exactly what a live "pick 480p" should do.
  const decision = applyQualityCeiling(baseDecision, target.maxHeight, Number(metadata.height) || 0);
  const probeSummary = seekableVod
    ? `client=${capabilities.client} container=${String(extension || 'unknown').toLowerCase()} video=${metadata.videoCodec || 'unknown'} videoProfile=${metadata.videoProfile || 'unknown'} pixelFormat=${metadata.pixelFormat || 'unknown'} bitDepth=${metadata.videoBitDepth || 'unknown'} size=${metadata.width || 0}x${metadata.height || 0} fps=${metadata.frameRate || 'unknown'} audio=${metadata.audioCodec || 'unknown'} audioChannels=${metadata.audioChannels || 0}`
    : `client=${target.client || 'live'} container=${String(extension || 'unknown').toLowerCase()}`;
  console.log(`[Media HLS strategy] ${kind}:${id} ${probeSummary} videoMode=${decision.videoMode} audioMode=${decision.audioMode} strategy=${decision.strategy} reason="${decision.reason}"`);
  const mode = strategyUsesEncoding(decision) ? 'transcode' : 'remux';
  // Every Roku strategy that converts video uses the stable VAAPI path. Remux
  // and audio-only conversion preserve the original video bitstream.
  const hardwareTranscode = seekableVod && target.client === PlaybackClient.ROKU && decision.videoMode === 'transcode';
  if (hardwareTranscode) console.log(`[Media HLS strategy] ${kind}:${id} Roku fallback GPU=VAAPI device=${process.env.HLS_VAAPI_DEVICE || '/dev/dri/renderD128'} video=h264_vaapi audio=aac keyframes=2s`);
  const { job } = await mediaJobs.getOrCreate({
    key, mode, allowCpuPressure: true, hlsStrategy: decision.strategy, hlsVideoMode: decision.videoMode, hlsAudioMode: decision.audioMode, hlsDecision: decision,
    persistent: true, sourceId: String(source._id), capacityKey, mediaId: String(id), kind,
    startSeconds, durationSeconds: Number(metadata.containerSeconds) || 0, userId: identity.userId, deviceId: identity.deviceId, viewerId: identity.viewerId,
    clientIp: identity.clientIp, client: identity.client,
    wwpSessionId: String(identity.wwpSessionId || ''), wwpQuality: String(identity.wwpQuality || ''),
  }, async () => {
    const generationId = randomUUID();
    const directory = path.join(rokuHlsRoot, generationId);
    await fs.mkdir(directory, { recursive: true });
    const manifest = path.join(directory, 'master.m3u8');
    const retainSegments = target.client === PlaybackClient.ROKU;
    // A seek needs its first playable segment quickly. Keep keyframe-safe
    // boundaries and the usual two-second cadence after the opening segment.
    const fastStart = seekableVod && [PlaybackClient.ROKU, PlaybackClient.BROWSER].includes(target.client) && decision.videoMode === 'transcode';
    const playlistProfile = hlsPlaylistProfile({ fastStart, preview: previewRemux, client: target.client });
    const args = ['-hide_banner', '-nostats', '-loglevel', 'info', ...hlsHwDeviceArgs({ enabled: hardwareTranscode })];
    if (startSeconds > 0) args.push('-ss', String(startSeconds));
    args.push(
    // Keep a live, rolling manifest. Do not mark it VOD or EVENT: VOD made Roku
    // freeze the first short manifest, while EVENT retains an unbounded history.
    // Normal playback stays near playback speed. Preview startup is allowed to
    // catch up immediately and uses a bounded low-latency input analysis.
                  ...hlsInputArgs(kind === 'channel', hlsVodInitialBurstSeconds, hlsVodReadrate), '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', inputUrl,
    '-map', '0:v:0?', '-map', '0:a:0?', ...hlsCodecArgs(decision, { fastStart, hardware: hardwareTranscode }), '-sn', '-dn',
                  '-f', 'hls',
                  ...(playlistProfile.initialSegmentSeconds > 0 ? ['-hls_init_time', String(playlistProfile.initialSegmentSeconds)] : []),
                  '-hls_time', String(playlistProfile.segmentSeconds), '-hls_list_size', String(playlistProfile.listSize),
                  ...(retainSegments ? [] : ['-hls_delete_threshold', '6']),
                  '-hls_flags', hlsMuxerFlags({ deleteSegments: !retainSegments }), '-flush_packets', '1',
    '-hls_segment_filename', path.join(directory, 'segment-%06d.ts'), manifest,
    );
    const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const safeCommand = [ffmpegBin, ...args].map(value => value === inputUrl ? '[provider URL]' : String(value)).join(' ');
    console.log(`[Media HLS ffmpeg] sessionId=${identity.sessionId || 'none'} generationId=${generationId} playbackAttemptId=${identity.playbackAttemptId || 'unknown'} resume=${startSeconds}s command=${safeCommand}`);
    // Learn runtime from this process's input header, without a second
    // provider connection. Never retain an unbounded FFmpeg log.
    let inputHeader = '';
    let inputHeaderComplete = !seekableVod;
    const created = {
      generationId, directory, manifest, child, error: '', retainSegments, activeRequests: 0,
      stop: async () => {
        await terminateChild(child);
        if (retainSegments || target.client === PlaybackClient.BROWSER) retireHlsGeneration(key, hlsGenerationJobs.get(generationId) || created);
        else {
          hlsGenerationJobs.delete(generationId);
          await fs.rm(directory, { recursive: true, force: true });
        }
      },
    };
    hlsGenerationJobs.set(generationId, created);
    child.stderr.on('data', chunk => {
      if (!inputHeaderComplete) {
        inputHeader = (inputHeader + chunk.toString()).slice(0, 16384);
        const seconds = inputDurationSeconds(inputHeader);
        if (seconds > 0) rememberVodDuration(String(source._id), kind, String(id), seconds);
        if (seconds > 0 || /Output #\d/.test(inputHeader) || inputHeader.length >= 16384) {
          inputHeaderComplete = true;
          inputHeader = '';
        }
      }
      created.error = appendTail(created.error, chunk);
      const registered = mediaJobs.get(key);
      if (registered?.child === child) registered.error = created.error;
    });
    child.on('error', error => {
      created.error = appendTail(created.error, error.message);
      const registered = mediaJobs.get(key);
      if (registered?.child === child) registered.error = created.error;
    });
    const ffmpegStartedAt = Date.now();
    child.on('close', code => {
      created.finished = true;
      created.completed = seekableVod && code === 0;
      const registered = mediaJobs.get(key);
      if (registered?.child === child) {
        registered.finished = true;
        registered.completed = created.completed;
      }
      const safeError = created.error.replaceAll(inputUrl, '[provider URL]');
      const runtimeSeconds = Math.max(0, Math.round((Date.now() - ffmpegStartedAt) / 1000));
      const detail = safeError.trim().slice(-240);
      const message = `[Media HLS] ${kind}:${id} ffmpeg exited code=${code ?? 'null'} runtime=${runtimeSeconds}s${detail ? ` detail=${detail}` : ''}`;
      if (code !== 0 && code !== null) {
        console.warn(message);
        const active = mediaJobs.get(key);
        if (active?.child === child) mediaJobs.remove(key, 'ffmpeg-error').catch(() => {});
      } else {
        console.log(message);
      }
    });
    return created;
  });
  if (job?.generationId) hlsGenerationJobs.set(job.generationId, job);
  reconcileWwpSession(identity.wwpSessionId, { key, sourceId: String(source._id), kind, id: String(id), extension: String(extension || ''), start: startSeconds, quality: identity.wwpQuality, ownerId: identity.userId, userSeek: identity.wwpSeek });
  return job;
}

// One centralized sweep owns idle FFmpeg jobs, cache pressure, and a second
// application-level segment bound in case a provider/ffmpeg edge case defeats
// the HLS delete flags.
let mediaHousekeepingRunning = false;
setInterval(async () => {
  if (mediaHousekeepingRunning) return;
  mediaHousekeepingRunning = true;
  try {
  const pressure = memoryPressure(mediaLimits);
  evictNativeHlsSessions();
  if (pressure.soft) { evictXtreamCache(Date.now(), true); evictM3uCache(Date.now(), true); evictPreviewCache(Date.now(), true); }
  await mediaJobs.sweep({ aggressive: pressure.hard });
  await Promise.allSettled([...mediaJobs.values()].filter(job => job.persistent).map(enforceHlsFileBound));
  } finally { mediaHousekeepingRunning = false; }
}, 5_000).unref();

app.get('/api/xtream/hls/:sourceId/:kind/:id/master.m3u8', async (req, res) => {
  const manifestRequestStartedAt = Date.now();
  const requestAbort = new AbortController();
  res.once('close', () => requestAbort.abort(new Error('Manifest client disconnected')));
  try {
    // Channels use the same backend HLS pipeline as VOD. Redirecting Roku to
    // the provider's live manifest exposed malformed headers and provider
    // segment URLs directly to the TV.
    if (!['channel', 'movie', 'series'].includes(req.params.kind)) return res.sendStatus(400);
    // A Watch with Partner joiner authenticates with the host's stream ticket
    // and may also be sending their OWN device token (different account) - the
    // source belongs to the host, so resolve it under the ticket's owner first.
    const manifestTicket = resolveStreamTicket(requestStreamTicket(req), req.params.sourceId, req.params.kind, req.params.id);
    const source = await getXtreamSource(req.params.sourceId, manifestTicket?.accountOwnerId || requestAccountOwner(req));
    if (!source) return res.sendStatus(404);
    const target = playbackTarget(req);
    const suppliedProviderURL = String(req.query.providerURL || '');
    if (target.client === PlaybackClient.BROWSER && !suppliedProviderURL) return res.status(400).json({ error: 'The original provider URL is required for browser streaming.' });
    if (suppliedProviderURL || target.client === PlaybackClient.ANDROID) {
      await requestProviderUrl(req, source, req.params.kind, req.params.id, req.query.ext);
    }
    const seekableVod = req.params.kind === 'movie' || req.params.kind === 'series';
    const startSeconds = seekableVod ? hlsStartSeconds(req.query.start) : 0;
    const fastPreview = req.params.kind === 'channel' && String(req.query.preview || '') === '1';
    const nativeHlsDisabled = String(req.query.native || '') === '0';
    const identity = mediaIdentity(req);
    console.log(`[Media HLS] ${req.params.kind}:${req.params.id} manifest requested start=${startSeconds}s ext=${String(req.query.ext || '') || 'unknown'} client=${target.client} preview=${fastPreview} wwp=${identity.wwpSessionId ? identity.wwpSessionId.slice(0, 8) : 'none'}`);
    if (req.params.kind === 'channel') {
      const existingNativeSession = nativeHlsSession(req, identity);
      if ((nativeHlsDisabled || target.maxHeight) && existingNativeSession) nativeHlsSessions.delete(existingNativeSession.key);
      // Android can reach RH over HTTPS but some provider playlists point at
      // segment hosts/ports that the phone's network blocks. Proxy the original
      // HLS playlist and rewrite every child URI through RH. This is still
      // provider-native playback: the media bytes and codecs are unchanged.
      if (target.client === PlaybackClient.ANDROID && !fastPreview && !nativeHlsDisabled && !target.maxHeight) {
        const session = existingNativeSession || nativeHlsSession(req, identity, true);
        try {
          const upstreamUrl = suppliedProviderURL || session.rootUrl || await sourceProviderUrl(source, 'channel', req.params.id, req.query.ext);
          await serveNativeHlsManifest(req, res, upstreamUrl, session, requestAbort.signal);
          console.log(`[Native HLS] channel:${req.params.id} Android passthrough ready startupMs=${Date.now() - manifestRequestStartedAt}`);
          return;
        } catch (error) {
          nativeHlsSessions.delete(session.key);
          if (res.headersSent || res.destroyed) return;
          console.warn(`[Native HLS] channel:${req.params.id} Android passthrough unavailable; using HLS pipeline: ${error.message}`);
        }
      }
      // A manual quality rung means transcode-to-that-height; the native
      // passthrough just relays the provider's own manifest unmodified, so it
      // can never honor a rung and must be skipped in favor of the ffmpeg path.
      if (!fastPreview && !nativeHlsDisabled && !target.maxHeight && existingNativeSession) {
        const session = existingNativeSession || nativeHlsSession(req, identity, true);
        try {
          const upstreamUrl = session.rootUrl || await sourceProviderUrl(source, 'channel', req.params.id, req.query.ext);
          await serveNativeHlsManifest(req, res, upstreamUrl, session, requestAbort.signal);
          console.log(`[Native HLS] channel:${req.params.id} manifest ready preview=${fastPreview} startupMs=${Date.now() - manifestRequestStartedAt}`);
          return;
        } catch (error) {
          nativeHlsSessions.delete(session.key);
          if (res.headersSent || res.destroyed) return;
          console.warn(`[Native HLS] channel:${req.params.id} unavailable; using compatibility remux: ${error.message}`);
        }
      }
    }
    // Native HLS failures use the stable independent-segment pipeline. The
    // aggressive split-by-time preview experiment produced Roku -3/-5 errors.
    const explicitFallback = requestedHlsFallback(req);
    const requestedFallback = fastPreview && !target.maxHeight && !explicitFallback
      ? 'preview-remux'
      : explicitFallback;
    let job = await getOrStartRokuHls(source, req.params.kind, req.params.id, req.query.ext, startSeconds, identity, target, requestedFallback, suppliedProviderURL);
    let playlistProfile = hlsPlaylistProfile({ preview: fastPreview, client: target.client });
    let manifestReady = false;
    // At most two bounded fallbacks are allowed. Accurate probe metadata
    // should select the first strategy; retries exist only for an unexpected
    // MPEG-TS mux/runtime incompatibility.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Roku abandons a manifest request at roughly 50 seconds. A compatible
      // stream-copy normally closes its first segment in under eight seconds;
      // beyond that, do not spend the remaining startup window on another
      // video-copy attempt with the same sparse-keyframe limitation.
      const firstAttemptTimeout = hlsManifestStartupTimeoutMs({ seekableVod, client: target.client, strategy: job.hlsStrategy });
      manifestReady = await waitForHlsManifest(job.manifest, attempt === 0 ? firstAttemptTimeout : 20_000, requestAbort.signal, () => job.finished === true, playlistProfile.startupSegments);
      if (manifestReady || job.hlsStrategy === HlsStrategy.FULL_TRANSCODE || attempt === 2) break;
      // The provider refused the connection (rate limit, geo/auth block). No
      // ffmpeg strategy fixes that - stop the fallback cascade and cache the
      // refusal so the client's retries do not keep hitting the line.
      if (seekableVod && providerRefusalPattern.test(job.error || '')) {
        markProviderUnavailable(`${source._id}:${req.params.kind}:${req.params.id}:${String(req.query.ext || '').toLowerCase()}`, job.error);
        await mediaJobs.remove(job.key, 'provider-refused');
        break;
      }
      const fallback = fallbackHlsStrategy(job.hlsDecision);
      console.warn(`[Media HLS] ${req.params.kind}:${req.params.id} ${job.hlsStrategy} produced no playable segment; retrying ${fallback.strategy} videoMode=${fallback.videoMode} audioMode=${fallback.audioMode}`);
      await mediaJobs.remove(job.key, 'compatibility-fallback');
      job = await getOrStartRokuHls(source, req.params.kind, req.params.id, req.query.ext, startSeconds, identity, target, fallback, suppliedProviderURL);
      playlistProfile = hlsPlaylistProfile({ preview: fastPreview, client: target.client });
    }
    if (!manifestReady) {
      const detail = job.error.trim().slice(-240);
      if (providerRefusalPattern.test(job.error || '')) {
        console.warn(`[Media HLS] ${req.params.kind}:${req.params.id} provider refused: ${detail || 'none'}`);
        return res.status(502).json({ error: 'The playlist provider is refusing this stream right now (rate limit or block). Try again shortly.' });
      }
      console.warn(`[Media HLS] ${req.params.kind}:${req.params.id} manifest timeout detail=${detail || 'none'}`);
      return res.status(504).json({ error: detail || 'HLS manifest is still being prepared' });
    }
    mediaJobs.touch(job, identity.viewerId);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    // Lets a client show what the server actually did with this file (a copy
    // remux, or an audio/video/full transcode) - separate from the quality
    // rung the viewer picked, which only caps resolution and says nothing
    // about whether encoding happened at all.
    res.setHeader('X-RH-Strategy', job.hlsStrategy || '');
    res.setHeader('X-RH-Video-Mode', job.hlsVideoMode || '');
    res.setHeader('X-RH-Duration', String(job.durationSeconds || 0));
    res.setHeader('X-RH-Audio-Mode', job.hlsAudioMode || '');
    // Watch-with-Partner start barrier: for a short window, withhold the real
    // manifest (serve an empty live playlist that clients just keep polling)
    // until BOTH players have connected AND the job has >= 2 segments, so
    // neither starts on a frame the other cannot play. FAIL-SAFE: after
    // WWP_BARRIER_MS we serve the real manifest regardless - a partner that
    // never shows must not freeze the one who is here.
    if (identity.wwpSessionId && !job.finished) {
      const wwpSession = getWwpSession(identity.wwpSessionId);
      const present = wwpSession?.presence?.size || 0;
      const sessionAgeMs = Date.now() - (wwpSession?.createdAt || manifestRequestStartedAt);
      let readySegments = 0;
      try {
        readySegments = (await fs.readFile(job.manifest, 'utf8')).match(/^segment-\d{6}\.ts/gm)?.length || 0;
      } catch { /* manifest not written yet */ }
      // Hold the real manifest back only until both partners are polling the
      // session AND a couple of segments exist - or WWP_BARRIER_MS elapses,
      // whichever comes first. The ceiling is the fail-safe: a partner that
      // never loads must never freeze the one who is here.
      const WWP_BARRIER_MS = 20_000;
      if (!(present >= 2 && readySegments >= 2) && sessionAgeMs < WWP_BARRIER_MS) {
        console.log(`[Media HLS] ${req.params.kind}:${req.params.id} wwp barrier: present=${present} segments=${readySegments} age=${Math.round(sessionAgeMs / 1000)}s`);
        return res.send('#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n');
      }
    }
    // Roku uses the device token on the manifest request, but relative HLS
    // segment URLs do not inherit that query string. Carry the token onto
    // each segment URL so the authenticated /api/xtream middleware accepts
    // the subsequent video requests instead of returning a JSON 401 body.
    let manifestText = await fs.readFile(job.manifest, 'utf8');
    const segmentQuery = hlsChildRequestQuery(req.query, startSeconds);
    if (job.generationId) segmentQuery.set('generation', job.generationId);
    if ([...segmentQuery].length > 0) {
      const query = segmentQuery.toString();
      manifestText = manifestText.split('\n').map(line => (
        /^segment-\d{6}\.ts$/.test(line.trim()) ? `${line}?${query}` : line
      )).join('\n');
    }
    if (req.params.kind === 'channel' && !manifestText.includes('#EXT-X-START')) {
      // A reconnect (stall recovery, quality switch, app resume) swaps in a
      // fresh Video.content, which Roku treats as loading brand-new media: it
      // starts at the FIRST segment of whatever rolling window this manifest
      // currently lists - tens of seconds behind live, not "where it stopped"
      // (which does not exist for live TV; the job's own rolling buffer is
      // all there is). EXT-X-START is the standard HLS tag (RFC 8216 4.3.5.2)
      // for exactly this: tell any compliant player, Roku included, to start
      // a few seconds behind the live edge instead of at the oldest segment.
      const liveStartOffset = -(playlistProfile.segmentSeconds * 3);
      manifestText = manifestText.replace('#EXTM3U', `#EXTM3U\n#EXT-X-START:TIME-OFFSET=${liveStartOffset},PRECISE=NO`);
    }
    const segmentCount = manifestText.split('\n').filter(line => /^segment-\d{6}\.ts(?:\?|$)/.test(line.trim())).length;
    console.log(`[Media HLS] ${req.params.kind}:${req.params.id} manifest ready segments=${segmentCount} mode=${job.mode || 'unknown'} preview=${fastPreview} startupMs=${Date.now() - manifestRequestStartedAt}`);
    res.send(manifestText);
  } catch (error) {
    console.warn(`[Media HLS] ${req.params.kind}:${req.params.id} manifest failed: ${error.message}`);
    if (res.headersSent || res.destroyed) return;
    if (!capacityResponse(res, error)) res.status(502).json({ error: error.message });
  }
});

app.get('/api/xtream/hls/:sourceId/channel/:id/resource/:resourceId', async (req, res) => {
  const controller = new AbortController();
  const abortUpstream = () => controller.abort(new Error('Native HLS client disconnected'));
  res.once('close', abortUpstream);
  let releaseDirectStream;
  try {
    const identity = mediaIdentity(req);
    const session = nativeHlsSession(req, identity);
    const upstreamUrl = session?.resources.get(req.params.resourceId);
    if (!session || !upstreamUrl) {
      console.warn(`[Native HLS] channel:${req.params.id} resource miss session=${Boolean(session)} resources=${session?.resources.size || 0} resource=${req.params.resourceId}`);
      res.setHeader('Cache-Control', 'no-store');
      return res.sendStatus(404);
    }
    if (session.userId && session.userId !== mediaOwner(req)) {
      console.warn(`[Native HLS] channel:${req.params.id} resource owner mismatch`);
      res.setHeader('Cache-Control', 'no-store');
      return res.sendStatus(404);
    }
    releaseDirectStream = directStreamLimiter.acquire(req.params.sourceId);
    const prefetched = session.resourceBodies?.get(upstreamUrl);
    if (prefetched) {
      session.resourceBodies.delete(upstreamUrl);
      res.setHeader('Content-Type', prefetched.contentType || 'video/mp2t');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-RH-Strategy', 'DIRECT');
      res.setHeader('X-RH-Video-Mode', 'copy');
      return res.send(prefetched.body);
    }
    const headers = { 'user-agent': req.headers['user-agent'] || 'RH-Stream/1.0' };
    if (req.headers.range) headers.range = req.headers.range;
    // Many IPTV lines permit only one provider request at a time. Media3 can
    // ask for the refreshed playlist and next segment concurrently, which
    // makes those providers return 403 or stall. Buffer each small HLS child
    // under a per-session lock, then release the provider connection before
    // serving it to Android.
    const upstream = await nativeHlsResourceLocks.run(session.key, async () => {
      const response = await fetch(upstreamUrl, {
        headers: { ...headers, connection: 'close' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      });
      const body = Buffer.from(await response.arrayBuffer());
      return { ok: response.ok, status: response.status, headers: response.headers, body, finalUrl: response.url || upstreamUrl };
    });
    if (!upstream.ok && upstream.status !== 206) {
      const cached = session.manifests?.get(upstreamUrl);
      if (cached) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-RH-Strategy', 'DIRECT');
        return res.send(cached);
      }
      return res.sendStatus(upstream.status || 502);
    }
    const contentType = upstream.headers.get('content-type') || '';
    if (isHlsManifest(contentType, upstreamUrl, upstream.body.toString('utf8'))) {
      const normalizedManifest = normalizeNativeHlsTimeline(upstream.body.toString('utf8'), upstream.finalUrl, session);
      const manifest = await selectStableAndroidLiveStart(normalizedManifest, upstream.finalUrl, session, controller.signal);
      const rewritten = rewriteHlsManifest(manifest, upstream.finalUrl, url => nativeHlsResourcePath(req, session, url));
      session.manifests.set(upstreamUrl, rewritten);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(rewritten);
    }
    for (const name of ['content-length', 'content-range', 'content-type', 'etag', 'last-modified', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(upstream.status);
    res.send(upstream.body);
  } catch (error) {
    if (!res.headersSent && !res.destroyed && !capacityResponse(res, error)) {
      res.status(error.name === 'AbortError' ? 499 : 502).json({ error: error.message });
    }
  } finally {
    releaseDirectStream?.();
    res.off('close', abortUpstream);
  }
});

app.get('/api/xtream/hls/:sourceId/:kind/:id/:segment', async (req, res) => {
  let job;
  try {
    if (!/^segment-\d{6}\.ts$/.test(req.params.segment)) {
      console.warn(`[Media HLS] ${req.params.kind}:${req.params.id} invalid segment=${req.params.segment}`);
      return res.sendStatus(404);
    }
    const seekableVod = req.params.kind === 'movie' || req.params.kind === 'series';
    const startSeconds = seekableVod ? hlsStartSeconds(req.query.start) : 0;
    const target = playbackTarget(req);
    const wwpSessionId = String(req.query.wwpSessionId || '');
    // Match getOrStartRokuHlsUnlocked: a WWP job key is session-only (start
    // excluded), so both participants' segment requests resolve to the one job
    // no matter which slightly-different -ss their manifest URL carries.
    const capabilityKey = wwpSessionId
      ? `wwp:${wwpSessionId}`
      : (seekableVod || target.maxHeight) ? target.key : '';
    const recoveryFallback = requestedHlsFallback(req);
    const keyedCapability = `${capabilityKey}${recoveryFallback ? `:hls-fallback-${recoveryFallback}` : ''}`;
    const key = rokuHlsKey(req.params.sourceId, req.params.kind, req.params.id, req.query.ext,
      wwpSessionId && seekableVod ? 0 : startSeconds, keyedCapability);
    const requestedGeneration = String(req.query.generation || '');
    job = requestedGeneration ? hlsGenerationJobs.get(requestedGeneration) : mediaJobs.get(key);
    if (!job) {
      // The other WWP participant may still be creating the shared job - give it
      // a moment rather than rejecting the segment outright.
      const jobDeadline = Date.now() + (wwpSessionId ? 6000 : 1000);
      while (!job && Date.now() < jobDeadline) {
        await new Promise(resolve => setTimeout(resolve, 200));
        job = requestedGeneration ? hlsGenerationJobs.get(requestedGeneration) : mediaJobs.get(key);
      }
    }
    if (!job) {
      console.warn(`[Media HLS] ${req.params.kind}:${req.params.id} segment missing job segment=${req.params.segment} start=${startSeconds}s`);
      return res.sendStatus(404);
    }
    // A stream ticket valid for this exact (source, kind, id) is itself full
    // authorization to pull the segment - it is what the host handed the
    // invited partner, whose own account never owns this job. Otherwise fall
    // back to matching the job's owner (or any listed WWP participant).
    const segmentTicketValid = Boolean(resolveStreamTicket(requestStreamTicket(req), req.params.sourceId, req.params.kind, req.params.id));
    const wwpParticipants = wwpSessionId ? getWwpSession(wwpSessionId)?.participantOwnerIds : null;
    const ownerAllowed = segmentTicketValid || !job.userId || job.userId === mediaOwner(req)
      || (wwpParticipants && wwpParticipants.has(String(mediaOwner(req) || '')));
    if (!ownerAllowed) {
      console.warn(`[Media HLS] ${req.params.kind}:${req.params.id} segment owner mismatch segment=${req.params.segment}`);
      return res.sendStatus(404);
    }
    if (job.state !== 'retiring') mediaJobs.touch(job, mediaIdentity(req).viewerId);
    let requestReleased = false;
    const releaseRequest = () => {
      if (requestReleased) return;
      requestReleased = true;
      job.activeRequests = Math.max(0, Number(job.activeRequests || 0) - 1);
    };
    job.activeRequests = Number(job.activeRequests || 0) + 1;
    res.once('finish', releaseRequest);
    res.once('close', releaseRequest);
    const filename = path.join(job.directory, req.params.segment);
    // ffmpeg can list a segment in the manifest a beat before its temp file is
    // renamed into place, and a CPU-bound transcode widens that window. Wait
    // briefly instead of handing the player a 404 (which it surfaces as
    // "Streaming server rejected the request").
    const segmentDeadline = Date.now() + 8000;
    for (;;) {
      try { await fs.access(filename); break; }
      catch (accessError) {
        if (Date.now() >= segmentDeadline || job.finished) throw accessError;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filename, error => {
      releaseRequest();
      if (!error || res.destroyed || res.writableEnded) return;
      if (!res.headersSent) res.sendStatus(error.code === 'ENOENT' ? 404 : 502);
      else res.destroy(error);
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      let available = [];
      try { available = (await fs.readdir(job?.directory || '')).filter(name => /^segment-\d{6}\.ts$/.test(name)).sort(); } catch {}
      console.error(`[Media HLS] invariant ENOENT viewer=${mediaIdentity(req).viewerId || 'unknown'} session=${mediaIdentity(req).wwpSessionId || 'none'} generation=${job?.generationId || 'unknown'} state=${job?.state || 'unknown'} segment=${req.params.segment} requestedPath=${job?.directory || 'unknown'} oldestAvailableSegment=${available[0] || 'none'} latestProducedSegment=${available.at(-1) || 'none'} cleanupReason=${job?.stopReason || 'none'}`);
    } else {
      console.warn(`[Media HLS] ${req.params.kind}:${req.params.id} segment unavailable segment=${req.params.segment}: ${error.code || error.message}`);
    }
    if (!res.headersSent && !res.destroyed) res.sendStatus(404);
  }
});

app.get('/api/xtream/roku/:sourceId/:kind/:id', async (req, res) => {
  let job;
  let jobKey = '';
  let outputStarted = false;
  let startupTimer;
  try {
    const source = await getXtreamSource(req.params.sourceId, requestAccountOwner(req));
    if (!source) return res.sendStatus(404);
    if (!['movie', 'series'].includes(req.params.kind)) return res.sendStatus(400);

    // Several Xtream providers send MPEG-TS even for URLs ending in .mp4.
    // Roku reports that mismatch as "malformed data (-5)". Fragmented MP4
    // keeps the original H.264/AAC tracks while giving Roku a valid MP4
    // streaming container without downloading the whole file first.
    const inputUrl = await sourceProviderUrl(source, req.params.kind, req.params.id, req.query.ext);
    const strategy = choosePlaybackStrategy({ purpose: 'roku-fragmented-mp4', extension: req.query.ext });
    const identity = mediaIdentity(req);
    jobKey = `roku-remux:${source._id}:${req.params.kind}:${req.params.id}:${Date.now()}:${mediaRequestSequence++}`;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputUrl,
      '-map', '0:v:0?', '-map', '0:a:0?',
      // Xtream's transport streams carry AAC in ADTS packets. MP4 does not
      // accept that packet format as-is: without this conversion ffmpeg emits
      // just the initial 6 KB header, exits, and Roku stays at 100% forever.
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-sn', '-dn',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '2000000', '-flush_packets', '1',
      '-f', 'mp4', 'pipe:1',
    ];
    ({ job } = await mediaJobs.getOrCreate({
      key: jobKey,
      mode: strategy === PlaybackStrategy.TRANSCODE ? 'transcode' : 'remux',
      persistent: false,
      sourceId: String(source._id), mediaId: String(req.params.id), kind: req.params.kind,
      ...identity,
    }, async () => {
      const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      return { child, inputUrl, error: '', stop: () => terminateChild(child) };
    }));
    const { child } = job;
    child.stderr.on('data', chunk => { job.error = appendTail(job.error, chunk); });
    child.on('error', error => {
      console.error('[Xtream Roku remux] failed to start:', error.message);
      clearTimeout(startupTimer);
      job.finished = true;
      mediaJobs.remove(jobKey, 'spawn-error').catch(() => {});
      if (!res.headersSent) res.status(502).json({ error: 'Could not start Roku media remux' });
      else res.destroy(error);
    });
    child.on('close', code => {
      clearTimeout(startupTimer);
      job.finished = true;
      const safeErrorText = job.error.replaceAll(inputUrl, '[provider URL]');
      if (code !== 0 && code !== null) console.warn(`[Xtream Roku remux] ${req.params.kind}:${req.params.id} exited ${code}: ${safeErrorText.trim().slice(-240)}`);
      mediaJobs.remove(jobKey, 'complete').catch(() => {});
      if (outputStarted) {
        if (!res.writableEnded) res.end();
        return;
      }
      // Do not advertise an empty ffmpeg result as HTTP 200 video/mp4. Roku
      // interprets that response as malformed media (-5), hiding the actual
      // provider failure. Keep headers pending until media bytes exist.
      if (!res.headersSent && !res.destroyed && !res.writableEnded) {
        const upstreamStatus = job.error.match(/Server returned (\d{3})/i)?.[1];
        const error = upstreamStatus
          ? `Movie source is unavailable (upstream HTTP ${upstreamStatus})`
          : 'Movie source did not return playable media';
        res.status(502).json({ error });
      }
    });
    res.once('close', () => { clearTimeout(startupTimer); mediaJobs.remove(jobKey, 'client-disconnect').catch(() => {}); });

    child.stdout.once('readable', () => {
      if (res.writableEnded || res.destroyed) return;
      outputStarted = true;
      clearTimeout(startupTimer);
      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Accept-Ranges', 'none');
      pipeline(child.stdout, res).catch(error => {
        if (!res.destroyed) res.destroy(error);
        mediaJobs.remove(jobKey, 'stream-error').catch(() => {});
      });
    });
    startupTimer = setTimeout(() => {
      if (outputStarted || res.headersSent) return;
      mediaJobs.remove(jobKey, 'startup-timeout').catch(() => {});
      if (!res.destroyed && !res.writableEnded) res.status(504).json({ error: 'Movie source timed out before returning media' });
    }, 20_000);
    startupTimer.unref?.();
  } catch (error) {
    clearTimeout(startupTimer);
    if (jobKey) await mediaJobs.remove(jobKey, 'request-error').catch(() => {});
    if (!res.headersSent) {
      if (!capacityResponse(res, error)) res.status(502).json({ error: error.message });
    } else res.destroy(error);
  }
});
async function buildXtreamSeriesPayload({ limit, selected: suppliedSelected, accountOwner } = {}) {
  let selected = suppliedSelected || (await getAllXtreamItems('series', accountOwner)).slice().sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
  if (Number.isFinite(limit) && limit > 0) selected = selected.slice(0, limit);
  let cursor = 0;
  const groups = new Array(selected.length);
  async function worker() {
    while (cursor < selected.length) {
      const index = cursor++;
      const seriesItem = selected[index];
      const items = [];
      try {
        const source = await getXtreamSource(seriesItem.sourceId, accountOwner);
        if (!source) { groups[index] = items; continue; }
        const details = await getXtreamSeriesEpisodes(source, seriesItem.id);
        for (const episode of details.episodes) {
          const extension = String(episode.extension || '').toLowerCase();
          const playbackUrl = rokuXtreamPlaybackPath(source._id, 'series', episode.id, extension);
          const title = episode.title || `${details.title} · ${episode.episodeNumber}`;
          items.push({
            id: episode.id,
            sourceId: String(source._id),
            seriesId: String(seriesItem.id),
            favoriteId: `xtream:${source._id}:series:${episode.id}`,
            source: 'xtream', kind: 'episode', contentKind: 'episode',
            title, rokuTitle: rokuText(title), rokuTextKind: /[A-Za-z]/.test(title) ? 'latin' : 'arabic',
            seriesTitle: details.title, rokuSeriesTitle: rokuText(details.title),
            seasonTitle: episode.seasonTitle, rokuSeasonTitle: rokuText(episode.seasonTitle),
            seasonSort: episode.seasonNumber, episodeNumber: episode.episodeNumber,
            duration: displayDuration(episode.duration), thumbnail: episode.thumbnail,
            category: seriesItem.category,
            rokuCategory: seriesItem.rokuCategory,
            language: seriesItem.language,
            added: seriesItem.added,
            url: playbackUrl, playbackUrl, streamFormat: rokuXtreamStreamFormat(extension),
            originalFormat: extension || 'mp4',
            // Real provider URL for this episode - see selectedXtreamItem().
            providerUrl: sourceProviderUrl(source, 'series', episode.id, extension),
          });
        }
      } catch (error) {
        console.warn(`[Xtream] Could not expand series ${seriesItem.title}: ${error.message}`);
      }
      groups[index] = items;
    }
  }
  // More than two concurrent get_series_info payloads can exhaust Render's
  // small heap for long-running series.
  const concurrency = Math.min(2, Math.max(1, selected.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return groups.flat();
}
app.get('/api/roku/library', async (req, res) => {
  try {
    // Compatibility for older Roku packages. Read the provider live just like
    // the current per-kind endpoints; saved selections are only a separate
    // library filter.
    const accountOwner = requestAccountOwner(req);
    const [selectedSeries, selectedMovies, selectedChannels] = await Promise.all([
      getAllXtreamItems('series', accountOwner), getAllXtreamItems('movie', accountOwner), getAllXtreamItems('channel', accountOwner),
    ]);
    const [series, movies, channels] = await Promise.all([
      buildXtreamSeriesPayload({ selected: selectedSeries.slice(0, rokuInitialSeriesLimit), accountOwner }),
      buildXtreamMoviesPayload({ selected: selectedMovies, accountOwner }),
      Promise.resolve(buildXtreamChannelsPayload(selectedChannels)),
    ]);
    res.json({ items: [...series, ...movies, ...channels] });
  }
  catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/roku/series', async (req, res) => {
  try {
    const category = String(req.query.category || '');
    const pageInfo = rokuPage(req, rokuSeriesPageLimit);
    const selected = (await getAllXtreamItems('series', requestAccountOwner(req)))
      .filter(item => !category || item.category === category)
      .sort((a, b) => Number(b.added || 0) - Number(a.added || 0));
    const page = rokuPagePayload(selected, pageInfo);
    const items = page.items.map(item => ({
      id: `series-search:${item.sourceId}:${item.id}`,
      title: item.title,
      rokuTitle: rokuText(item.title),
      rokuTextKind: /[A-Za-z]/.test(item.title) ? 'latin' : 'arabic',
      category: item.category,
      language: item.language,
      sourceId: String(item.sourceId),
      seriesId: item.id,
      thumbnail: item.logo,
      added: item.added,
      contentKind: 'series-search',
    }));
    console.log(`[Roku] Series page ${pageInfo.page} ready: ${items.length}/${page.total}`);
    res.json({ ...page, items });
  } catch (error) {
    console.error('[Roku] Series catalog failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});
app.get('/api/roku/channels', async (req, res) => {
  try {
    const pageInfo = rokuPage(req, rokuChannelPageLimit);
    const selected = await getAllXtreamItems('channel', requestAccountOwner(req));
    const page = rokuPagePayload(selected, pageInfo);
    res.json({ ...page, items: buildXtreamChannelsPayload(page.items) });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
// Render storage is ephemeral, but a process crash can leave the prior job
// directories behind for the lifetime of the container. Empty the root rather
// than removing it - it may be a tmpfs mountpoint (EBUSY on rmdir).
async function clearHlsRoot() {
  await fs.mkdir(rokuHlsRoot, { recursive: true });
  const entries = await fs.readdir(rokuHlsRoot).catch(() => []);
  await Promise.all(entries.map(name => fs.rm(path.join(rokuHlsRoot, name), { recursive: true, force: true })));
}
await clearHlsRoot();
const resourceLogIntervalMs = Math.max(60_000, Number.parseInt(process.env.MEDIA_RESOURCE_LOG_INTERVAL_MS || '300000', 10) || 300_000);
setInterval(async () => {
  try {
    const snapshot = await mediaHealthSnapshot();
    console.log(`[Media health] rss=${snapshot.rssMB}MB heap=${snapshot.heapUsedMB}MB direct=${snapshot.activeDirectStreams} remux=${snapshot.activeRemuxJobs} transcode=${snapshot.activeTranscodes} hls=${snapshot.hlsDiskUsageMB}MB`);
  } catch (error) { console.warn(`[Media health] snapshot failed: ${error.message}`); }
}, resourceLogIntervalMs).unref();

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`RH Stream API listening on http://127.0.0.1:${port}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Server] ${signal} received; draining media jobs`);
  const closeServer = new Promise(resolve => server.close(resolve));
  const forceTimer = setTimeout(() => process.exit(1), 10_000);
  forceTimer.unref?.();
  await Promise.allSettled([closeServer, mediaJobs.shutdown()]);
  await clearHlsRoot().catch(error => console.warn(`[Media] HLS cleanup failed: ${error.message}`));
  clearTimeout(forceTimer);
  process.exit(0);
}

process.once('SIGTERM', () => { shutdown('SIGTERM').catch(error => { console.error(error); process.exit(1); }); });
process.once('SIGINT', () => { shutdown('SIGINT').catch(error => { console.error(error); process.exit(1); }); });
