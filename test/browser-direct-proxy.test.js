import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { proxyBrowserDirect } from '../browser-direct-proxy.js';

test('browser Direct follows provider redirects and preserves native range seeking', async t => {
  const bytes = Buffer.from('0123456789');
  let receivedRange;
  const provider = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/video' }); res.end(); return; }
    if (req.url === '/missing') { res.writeHead(403); res.end('provider credentials must not leak'); return; }
    receivedRange = req.headers.range;
    if (receivedRange) {
      res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': 'bytes 2-5/10', 'content-length': '4', 'accept-ranges': 'bytes' });
      res.end(bytes.subarray(2, 6));
    } else {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '10', 'accept-ranges': 'bytes' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    }
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const app = express();
  app.get('/:path', async (req, res) => {
    try { await proxyBrowserDirect(req, res, `http://127.0.0.1:${provider.address().port}/${req.params.path}`, 'mp4'); }
    catch (error) { if (!res.headersSent) res.status(502).end(); }
  });
  const proxy = app.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); provider.closeAllConnections(); provider.close(); });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const range = await fetch(`${base}/redirect`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(receivedRange, 'bytes=2-5');
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.equal(range.headers.get('location'), null);
  assert.equal(await range.text(), '2345');
  const full = await fetch(`${base}/video`);
  assert.equal(await full.text(), bytes.toString());
  const head = await fetch(`${base}/video`, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  const failed = await fetch(`${base}/missing`);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'Media provider returned HTTP 403' });
});
