import { createHash } from 'node:crypto';

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

export function normalizeHlsMasterForRoku(manifest, fallbackBandwidth = 2_500_000) {
  return String(manifest).split('\n').map(line => {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) return line;
    const match = line.match(/(?:^|,)BANDWIDTH=(\d+)/i);
    if (match && Number(match[1]) > 0) return line;
    if (match) return line.replace(/BANDWIDTH=\d+/i, `BANDWIDTH=${fallbackBandwidth}`);
    return `${line},BANDWIDTH=${fallbackBandwidth}`;
  }).join('\n');
}

export function rokuSingleVariantMaster(mediaPlaylistUri, bandwidth = 2_500_000) {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${Math.floor(bandwidth * 0.8)}`,
    mediaPlaylistUri,
    '',
  ].join('\n');
}
