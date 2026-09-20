import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Keep native browser media on the HTTPS app origin. Provider URLs can be
// HTTP, redirect across origins, or lack CORS. Bytes and Range semantics stay
// unchanged, so native MP4 playback and seeking require no FFmpeg job.
export async function proxyBrowserDirect(req, res, inputUrl, extension = '') {
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  const headerTimeout = setTimeout(abort, 12_000);
  let upstream;
  try {
    const headers = { 'user-agent': 'RH-Stream/1.0', 'accept-encoding': 'identity' };
    if (req.headers.range) headers.range = req.headers.range;
    if (req.headers['if-range']) headers['if-range'] = req.headers['if-range'];
    upstream = await fetch(inputUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, signal: controller.signal,
    });
    clearTimeout(headerTimeout);
    if (res.destroyed) return;
    if (![200, 206, 416].includes(upstream.status)) {
      res.status(502).json({ error: `Media provider returned HTTP ${upstream.status}` });
      return;
    }
    res.status(upstream.status);
    res.setHeader('Cache-Control', 'private, no-store');
    for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    const type = upstream.headers.get('content-type');
    res.setHeader('Content-Type', /^(mp4|m4v|mov)$/i.test(extension) ? 'video/mp4' : type || 'application/octet-stream');
    if (!upstream.body || req.method === 'HEAD') { res.end(); return; }
    await pipeline(Readable.fromWeb(upstream.body), res);
  } finally {
    clearTimeout(headerTimeout);
    controller.abort();
    await upstream?.body?.cancel().catch(() => {});
    res.off('close', abort);
  }
}
