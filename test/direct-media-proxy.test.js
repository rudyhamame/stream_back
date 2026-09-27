import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { isPublicAddress, openProviderMedia, validateMediaUrl } from '../direct-media-proxy.js';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await run(origin, server); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('public-address policy rejects local, link-local, RFC1918, and mapped private IPs', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.1.2', '192.168.1.9', '169.254.169.254', '::1', 'fc00::1', 'fe80::1', '::ffff:7f00:1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'http://localhost/x', 'http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data']) {
    assert.throws(() => validateMediaUrl(url));
  }
});

test('proxy preserves Range, 206 and provider headers, and HEAD metadata', async () => {
  await withServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '5000', 'accept-ranges': 'bytes', etag: '"media-v1"' });
      return res.end();
    }
    assert.equal(req.headers.range, 'bytes=1000-1999');
    res.writeHead(206, {
      'content-type': 'video/mp4', 'content-length': '1000', 'content-range': 'bytes 1000-1999/5000',
      'accept-ranges': 'bytes', etag: '"media-v1"', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT', 'cache-control': 'private, max-age=60',
    });
    res.end(Buffer.alloc(1000, 7));
  }, async origin => {
    const options = { url: `${origin}/media.mp4`, allowedRedirectHosts: ['127.0.0.1'], allowPrivateHosts: ['127.0.0.1'] };
    const ranged = await openProviderMedia({ ...options, requestHeaders: { range: 'bytes=1000-1999' } });
    assert.equal(ranged.response.statusCode, 206);
    assert.equal(ranged.response.headers['content-range'], 'bytes 1000-1999/5000');
    assert.equal(ranged.response.headers['content-length'], '1000');
    assert.equal(ranged.response.headers['accept-ranges'], 'bytes');
    assert.equal(ranged.response.headers.etag, '"media-v1"');
    assert.equal(ranged.response.headers['cache-control'], 'private, max-age=60');
    let bytes = 0;
    for await (const chunk of ranged.response) bytes += chunk.length;
    assert.equal(bytes, 1000);

    const head = await openProviderMedia({ ...options, method: 'HEAD' });
    assert.equal(head.response.statusCode, 200);
    assert.equal(head.response.headers['content-length'], '5000');
    assert.equal(head.response.headers.etag, '"media-v1"');
    head.response.destroy();
  });
});

test('redirect to a private destination is rejected before connecting to it', async () => {
  await withServer((_req, res) => {
    res.writeHead(302, { location: 'http://localhost:9/metadata' });
    res.end();
  }, async origin => {
    await assert.rejects(openProviderMedia({
      url: `${origin}/redirect`, allowedRedirectHosts: ['127.0.0.1'], allowPrivateHosts: ['127.0.0.1'],
    }), /private media destination/);
  });
});

test('aborting the client request closes the upstream response promptly', async () => {
  let upstreamClosedResolve;
  const upstreamClosed = new Promise(resolve => { upstreamClosedResolve = resolve; });
  await withServer((req, res) => {
    req.on('close', upstreamClosedResolve);
    res.writeHead(200, { 'content-type': 'video/mp4' });
    const timer = setInterval(() => res.write(Buffer.alloc(16 * 1024)), 10);
    res.on('close', () => clearInterval(timer));
  }, async origin => {
    const result = await openProviderMedia({
      url: `${origin}/slow`, allowedRedirectHosts: ['127.0.0.1'], allowPrivateHosts: ['127.0.0.1'],
    });
    await once(result.response, 'data');
    result.response.destroy(new Error('browser seeked away'));
    await Promise.race([upstreamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream stayed open')), 1000))]);
  });
});
