export function previewFrameSize({ playerFrame = false } = {}) {
  // JPEG's common 4:2:0 chroma layout requires even dimensions. Roku scales
  // the 520x292 card by one display pixel into its 520x293 preview area.
  return playerFrame ? { width: 1280, height: 720 } : { width: 520, height: 292 };
}
