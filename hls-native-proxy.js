import { createHash } from 'node:crypto';

export const HlsPlaylistType = Object.freeze({
  MASTER: 'MASTER_PLAYLIST',
  MEDIA: 'MEDIA_PLAYLIST',
  UNKNOWN: 'INVALID_OR_UNKNOWN',
});

export const HlsBitrateSource = Object.freeze({
  PROVIDER: 'PROVIDER',
  PROBE: 'PROBE',
  MEASURED_SEGMENTS: 'MEASURED_SEGMENTS',
  FALLBACK: 'FALLBACK',
});

export const DEFAULT_ROKU_FALLBACK_BITRATE = Object.freeze({
  bandwidth: 2_500_000,
  averageBandwidth: 2_000_000,
  bitrateSource: HlsBitrateSource.FALLBACK,
  reason: 'no_provider_probe_or_segment_measurement',
  sampleCount: 0,
});

export function hlsResourceId(url) {
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 24);
}

export function isHlsManifest(contentType, url, body = '') {
  return /(?:application|audio)\/(?:vnd\.apple\.)?mpegurl/i.test(String(contentType || ''))
    || /\.m3u8(?:$|[?#])/i.test(String(url || ''))
    || String(body || '').trimStart().startsWith('#EXTM3U');
}

export function rewriteHlsManifest(manifest, upstreamUrl, localUriForUrl) {
  const rewriteUrl = value => localUriForUrl(new URL(value, upstreamUrl).toString());
  return String(manifest).split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (!trimmed.startsWith('#')) return rewriteUrl(trimmed);
    return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewriteUrl(uri)}"`);
  }).join('\n');
}

export function hasHlsVariants(manifest) {
  return /^#EXT-X-STREAM-INF:/m.test(String(manifest));
}

export function classifyHlsPlaylist(manifest) {
  const text = String(manifest || '');
  if (!text.trimStart().startsWith('#EXTM3U')) return HlsPlaylistType.UNKNOWN;
  if (hasHlsVariants(text)) return HlsPlaylistType.MASTER;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^#EXTINF:/i.test(lines[index].trim())) continue;
    for (let child = index + 1; child < lines.length; child += 1) {
      const value = lines[child].trim();
      if (!value) continue;
      if (!value.startsWith('#')) return HlsPlaylistType.MEDIA;
      if (/^#EXTINF:/i.test(value)) break;
    }
  }
  return HlsPlaylistType.UNKNOWN;
}

export function validHlsBitrate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function attributeValue(line, name) {
  const match = String(line).match(new RegExp(`(?:^|[:,])${name}=([^,]*)`, 'i'));
  return match ? match[1].trim().replace(/^"|"$/g, '') : '';
}

export function providerMasterBitrateMetadata(manifest) {
  if (classifyHlsPlaylist(manifest) !== HlsPlaylistType.MASTER) return null;
  for (const line of String(manifest).split(/\r?\n/)) {
    if (!/^#EXT-X-STREAM-INF:/i.test(line.trim())) continue;
    const bandwidth = validHlsBitrate(attributeValue(line, 'BANDWIDTH'));
    if (!bandwidth) continue;
    const averageBandwidth = validHlsBitrate(attributeValue(line, 'AVERAGE-BANDWIDTH'));
    return {
      bandwidth,
      averageBandwidth: averageBandwidth || null,
      bitrateSource: HlsBitrateSource.PROVIDER,
      sampleCount: 0,
    };
  }
  return null;
}

export function parseHlsMediaSegments(manifest, manifestUrl = '') {
  if (classifyHlsPlaylist(manifest) !== HlsPlaylistType.MEDIA) return [];
  const lines = String(manifest).split(/\r?\n/);
  const baseSequence = Math.max(0, Number.parseInt(String(manifest).match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/mi)?.[1] || '0', 10) || 0);
  const result = [];
  let durationSec = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const duration = line.match(/^#EXTINF:([0-9]+(?:\.[0-9]+)?)/i);
    if (duration) {
      durationSec = Number.parseFloat(duration[1]);
      continue;
    }
    if (line.startsWith('#') || !(durationSec > 0)) continue;
    let url = line;
    try { if (manifestUrl) url = new URL(line, manifestUrl).toString(); }
    catch { /* retain the original URI for diagnostics */ }
    result.push({ sequence: baseSequence + result.length, durationSec, url });
    durationSec = 0;
  }
  return result;
}

export function createHlsSegmentBitrateSample(segment, payload) {
  const durationSec = Number(segment?.durationSec) || 0;
  const sizeBytes = Buffer.isBuffer(payload) || payload instanceof Uint8Array
    ? payload.byteLength
    : Number(payload?.sizeBytes ?? payload) || 0;
  if (!(durationSec > 0) || !(sizeBytes > 0)) return null;
  return {
    sequence: Number(segment?.sequence) || 0,
    durationSec,
    sizeBytes,
    bitrateBps: Math.round((sizeBytes * 8) / durationSec),
    url: String(segment?.url || ''),
  };
}

export function measuredHlsBitrateMetadata(samples, safetyFactor = 1.10) {
  const valid = (Array.isArray(samples) ? samples : []).filter(sample =>
    Number(sample?.durationSec) > 0 && Number(sample?.sizeBytes) > 0);
  if (!valid.length) return null;
  const totalSampleBytes = valid.reduce((sum, sample) => sum + Number(sample.sizeBytes), 0);
  const totalSampleDurationSec = valid.reduce((sum, sample) => sum + Number(sample.durationSec), 0);
  const segmentBitrates = valid.map(sample => Math.round((Number(sample.sizeBytes) * 8) / Number(sample.durationSec)));
  const measuredAverageBandwidth = Math.round((totalSampleBytes * 8) / totalSampleDurationSec);
  const measuredPeakSegmentBandwidth = Math.max(...segmentBitrates);
  const factor = Number.isFinite(Number(safetyFactor)) && Number(safetyFactor) >= 1 ? Number(safetyFactor) : 1.10;
  return {
    bandwidth: Math.round(measuredPeakSegmentBandwidth * factor),
    averageBandwidth: measuredAverageBandwidth,
    bitrateSource: HlsBitrateSource.MEASURED_SEGMENTS,
    sampleCount: valid.length,
    totalSampleBytes,
    totalSampleDurationSec,
    measuredAverageBandwidth,
    measuredPeakSegmentBandwidth,
    safetyFactor: factor,
  };
}

function normalizeBitrateMetadata(metadata) {
  const bandwidth = validHlsBitrate(metadata?.bandwidth);
  const averageBandwidth = validHlsBitrate(metadata?.averageBandwidth);
  if (!bandwidth) return { ...DEFAULT_ROKU_FALLBACK_BITRATE };
  return {
    ...metadata,
    bandwidth,
    averageBandwidth: averageBandwidth || null,
    bitrateSource: metadata?.bitrateSource || HlsBitrateSource.FALLBACK,
  };
}

export function normalizeHlsMasterForRoku(manifest, replacementMetadata = DEFAULT_ROKU_FALLBACK_BITRATE) {
  const replacement = normalizeBitrateMetadata(typeof replacementMetadata === 'number'
    ? { bandwidth: replacementMetadata, bitrateSource: HlsBitrateSource.FALLBACK, reason: 'legacy_numeric_fallback' }
    : replacementMetadata);
  return String(manifest).split('\n').map(line => {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) return line;
    const bandwidthText = attributeValue(line, 'BANDWIDTH');
    const bandwidth = validHlsBitrate(bandwidthText);
    let next = line;
    if (!bandwidth) {
      if (/(?:^|[:,])BANDWIDTH=[^,]*/i.test(next)) next = next.replace(/BANDWIDTH=[^,]*/i, `BANDWIDTH=${replacement.bandwidth}`);
      else next = `${next},BANDWIDTH=${replacement.bandwidth}`;
    }
    const averageText = attributeValue(next, 'AVERAGE-BANDWIDTH');
    if (averageText && !validHlsBitrate(averageText)) next = next.replace(/,?AVERAGE-BANDWIDTH=[^,]*/i, '');
    return next;
  }).join('\n');
}

export function rokuSingleVariantMaster(mediaPlaylistUri, metadata = DEFAULT_ROKU_FALLBACK_BITRATE) {
  const normalized = normalizeBitrateMetadata(typeof metadata === 'number'
    ? { bandwidth: metadata, bitrateSource: HlsBitrateSource.FALLBACK, reason: 'legacy_numeric_fallback' }
    : metadata);
  const attributes = [`BANDWIDTH=${normalized.bandwidth}`];
  if (normalized.averageBandwidth) attributes.push(`AVERAGE-BANDWIDTH=${normalized.averageBandwidth}`);
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-STREAM-INF:${attributes.join(',')}`,
    mediaPlaylistUri,
    '',
  ].join('\n');
}
