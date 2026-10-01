import {
  DEFAULT_ROKU_FALLBACK_BITRATE,
  HlsBitrateSource,
  HlsPlaylistType,
  createHlsSegmentBitrateSample,
  measuredHlsBitrateMetadata,
} from './hls-native-proxy.js';

// One server-scoped cache tracks measured Live bandwidth across native HLS
// sessions. Session segment bodies remain in the caller's short-lived cache.
export function createLiveBitrateCache({ sampleTarget, rollingSamples, safetyFactor, ttlMs }) {
  const measurements = new Map();

  function key(sourceId, channelId) {
    return `${String(sourceId)}:channel:${String(channelId)}`;
  }

  function evict(now = Date.now()) {
    for (const [id, entry] of measurements) if (entry.expiresAt <= now) measurements.delete(id);
    while (measurements.size > 128) measurements.delete(measurements.keys().next().value);
  }

  function get(sourceId, channelId) {
    evict();
    const entry = measurements.get(key(sourceId, channelId));
    return entry?.expiresAt > Date.now() ? entry : null;
  }

  function bitrateMbps(value) {
    return `${(Number(value || 0) / 1_000_000).toFixed(2)}Mbps`;
  }

  function log(entry) {
    const measurement = entry.measurement || {};
    const parts = [
      `[RH:HLS:BITRATE] channel=${entry.channelId}`,
      `playlist=${entry.playlistType === HlsPlaylistType.MASTER ? 'MASTER' : entry.playlistType === HlsPlaylistType.MEDIA ? 'MEDIA' : 'UNKNOWN'}`,
      `source=${entry.bitrateSource}`,
    ];
    if (entry.sampleCount) parts.push(`samples=${entry.sampleCount}`, `avg=${bitrateMbps(entry.averageBandwidth)}`, `peak=${bitrateMbps(measurement.peakBandwidth)}`);
    parts.push(`advertised=${bitrateMbps(entry.bandwidth)}`, `fallback=${entry.fallbackUsed === true}`);
    if (entry.reason) parts.push(`reason=${String(entry.reason).replace(/\s+/g, '-')}`);
    console.log(parts.join(' '));
  }

  function store(sourceId, channelId, details) {
    const now = Date.now();
    const id = key(sourceId, channelId);
    const prior = measurements.get(id);
    const samples = Array.isArray(details.samples) ? details.samples.slice(-rollingSamples) : (prior?.samples || []);
    let bandwidth = Number(details.bandwidth) || 0;
    let averageBandwidth = Number(details.averageBandwidth) || null;
    const sameMeasuredSource = prior?.bitrateSource === HlsBitrateSource.MEASURED_SEGMENTS
      && details.bitrateSource === HlsBitrateSource.MEASURED_SEGMENTS;
    if (sameMeasuredSource && prior.bandwidth > 0 && Math.abs(bandwidth - prior.bandwidth) / prior.bandwidth < 0.05) bandwidth = prior.bandwidth;
    if (sameMeasuredSource && prior.averageBandwidth > 0 && averageBandwidth > 0
        && Math.abs(averageBandwidth - prior.averageBandwidth) / prior.averageBandwidth < 0.05) averageBandwidth = prior.averageBandwidth;
    const entry = {
      sourceId: String(sourceId),
      channelId: String(channelId),
      playlistType: details.playlistType || prior?.playlistType || HlsPlaylistType.UNKNOWN,
      provider: details.provider || prior?.provider || { bandwidth: null, averageBandwidth: null },
      bandwidth,
      averageBandwidth,
      bitrateSource: details.bitrateSource || HlsBitrateSource.FALLBACK,
      sampleCount: Number(details.sampleCount) || 0,
      samples,
      measurement: details.measurement || null,
      fallbackUsed: details.bitrateSource === HlsBitrateSource.FALLBACK,
      reason: details.reason || '',
      measuredAt: new Date(now).toISOString(),
      expiresAt: now + ttlMs,
    };
    measurements.delete(id);
    measurements.set(id, entry);
    evict(now);
    const materialChange = !prior || prior.bitrateSource !== entry.bitrateSource
      || prior.bandwidth <= 0 || Math.abs(entry.bandwidth - prior.bandwidth) / prior.bandwidth >= 0.05
      || entry.sampleCount === sampleTarget;
    if (materialChange) log(entry);
    return entry;
  }

  function recordSegment(sourceId, channelId, session, segment, body, playlistType = HlsPlaylistType.MEDIA) {
    const sample = createHlsSegmentBitrateSample(segment, body);
    if (!sample) return get(sourceId, channelId);
    const prior = get(sourceId, channelId);
    const identity = `${sample.sequence}:${sample.url}`;
    session.bitrateSamples.set(identity, sample);
    while (session.bitrateSamples.size > rollingSamples) session.bitrateSamples.delete(session.bitrateSamples.keys().next().value);
    const combined = new Map();
    for (const value of prior?.samples || []) combined.set(`${value.sequence}:${value.url}`, value);
    for (const [id, value] of session.bitrateSamples) combined.set(id, value);
    const rolling = [...combined.values()].slice(-rollingSamples);
    if (rolling.length < 2) return null;
    const measured = measuredHlsBitrateMetadata(rolling, safetyFactor);
    return store(sourceId, channelId, {
      playlistType,
      provider: { bandwidth: null, averageBandwidth: null },
      bandwidth: measured.bandwidth,
      averageBandwidth: measured.averageBandwidth,
      bitrateSource: HlsBitrateSource.MEASURED_SEGMENTS,
      sampleCount: measured.sampleCount,
      samples: rolling,
      measurement: {
        sampleCount: measured.sampleCount,
        totalSampleBytes: measured.totalSampleBytes,
        totalSampleDurationSec: measured.totalSampleDurationSec,
        averageBandwidth: measured.measuredAverageBandwidth,
        peakBandwidth: measured.measuredPeakSegmentBandwidth,
        normalizedBandwidth: measured.bandwidth,
        safetyFactor: measured.safetyFactor,
      },
    });
  }

  function fallback(sourceId, channelId, playlistType, reason) {
    return store(sourceId, channelId, {
      playlistType,
      provider: { bandwidth: null, averageBandwidth: null },
      ...DEFAULT_ROKU_FALLBACK_BITRATE,
      reason,
    });
  }

  return { measurements, evict, get, store, recordSegment, fallback };
}
