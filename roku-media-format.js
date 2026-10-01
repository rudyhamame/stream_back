export function rokuXtreamStreamFormat(extension = '') {
  const ext = String(extension).replace(/^\./, '').toLowerCase();
  if (['mkv', 'mka', 'mks'].includes(ext)) return ext;
  return ['mp4', 'mov', 'm4v'].includes(ext) ? 'mp4' : 'hls';
}

export function rokuXtreamPlaybackPath(sourceId, kind, id, extension = '') {
  const ext = String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (rokuXtreamStreamFormat(ext) !== 'hls' && kind !== 'channel') {
    return `/api/xtream/play/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`;
  }
  return `/api/xtream/hls/${encodeURIComponent(sourceId)}/${kind}/${encodeURIComponent(id)}/master.m3u8${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`;
}

export function directXtreamItem(item, formatTitle = value => String(value || '')) {
  const extension = String(item.extension || '').toLowerCase();
  const playbackUrl = rokuXtreamPlaybackPath(item.sourceId, item.kind, item.id, extension);
  return {
    ...item,
    source: 'xtream',
    favoriteId: `xtream:${item.sourceId}:${item.kind}:${item.id}`,
    url: playbackUrl,
    playbackUrl,
    rokuTitle: formatTitle(item.title),
    rokuTextKind: /[A-Za-z]/.test(item.title) ? 'latin' : 'arabic',
    originalFormat: extension || 'mp4',
    streamFormat: rokuXtreamStreamFormat(extension),
  };
}

export function buildXtreamChannelsPayload(items, formatTitle = value => String(value || '')) {
  return items.map(item => ({
    ...directXtreamItem(item, formatTitle),
    kind: 'channel', contentKind: 'channel',
    group: item.category || item.sourceName,
    rokuGroup: item.rokuCategory || formatTitle(item.sourceName),
  }));
}

export function createRokuMediaFormatter(formatTitle) {
  return {
    directXtreamItem: item => directXtreamItem(item, formatTitle),
    rokuXtreamStreamFormat,
    rokuXtreamPlaybackPath,
    buildXtreamChannelsPayload: items => buildXtreamChannelsPayload(items, formatTitle),
  };
}
