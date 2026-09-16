export function previewFrameSize() {
  // JPEG's common 4:2:0 chroma layout requires even dimensions. Roku scales
  // the 520x292 card by one display pixel into its 520x293 preview area.
  return { width: 520, height: 292 };
}

export function seekPreviewPosition(value, duration = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const upperBound = Number(duration) > 2 ? Number(duration) - 2 : 7 * 24 * 60 * 60;
  return Math.min(upperBound, Math.max(0, Math.round(parsed)));
}

export function previewInputArgs(kind, position) {
  if (kind !== 'movie' && kind !== 'series') return [];
  return ['-ss', seekPreviewPosition(position).toString()];
}
