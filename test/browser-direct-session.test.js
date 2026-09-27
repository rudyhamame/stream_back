import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { once } from 'node:events';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { copyMediaHeaders } from '../direct-media-proxy.js';

// Load the actual route without starting the production DB, jobs, or listener.
const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf("app.all('/api/xtream/direct-session/:token'");
const end = source.indexOf('// The Roku displays', start);
assert.ok(start >= 0 && end > start);

test('Browser Direct completes truthful 206 ranges when the provider ignores the requested end', async () => {
  const app = express();
  const chunkSize = 2 * 1024 * 1024;
  const total = 3 * chunkSize + 173;
  const upstreamRanges = [];
  const sessions = new Map([['ticket', {
    expiresAt: Date.now() + 60_000, playbackClientId: 'tab', rhMime: 'mkv',
    sourceId: 'source', accountOwner: 'owner', idHash: 'test',
  }]]);
  vm.runInNewContext(source.slice(start, end), {
    app, browserDirectSessions: sessions, evictBrowserDirectSessions() {},
    activeBrowserDirectRequests: new Map(), AbortController,
    getXtreamSource: async () => ({ ownerId: 'owner' }),
    directStreamLimiter: { acquire: () => () => {} },
    mediaStreamIdleTimeoutMs: 1000, process: { env: {} },
    copyMediaHeaders, Transform, pipeline,
    console: { info() {}, warn() {} },
    openProviderMedia: async ({ requestHeaders }) => {
      upstreamRanges.push(requestHeaders.range);
      const offset = Number(/^bytes=(\d+)-/.exec(requestHeaders.range)[1]);
      const response = Readable.from((function* () {
        for (let pos = offset; pos < total; pos += 65536) {
          yield Buffer.alloc(Math.min(65536, total - pos), Math.floor(offset / chunkSize));
        }
      })());
      response.statusCode = 206;
      response.headers = {
        'content-type': 'video/x-matroska',
        'content-range': `bytes ${offset}-${total - 1}/${total}`,
        'content-length': String(total - offset),
      };
      return { response };
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/xtream/direct-session/ticket?playbackClientId=tab&rhMime=mkv`;
  try {
    for (const [range, offset, length] of [
      ['bytes=0-', 0, chunkSize],
      [`bytes=${chunkSize}-`, chunkSize, chunkSize],
      ['bytes=0-1', 0, 2],
      [`bytes=${3 * chunkSize}-`, 3 * chunkSize, 173],
    ]) {
      const response = await fetch(url, { headers: { range } });
      assert.equal(response.status, 206, range);
      assert.equal(response.headers.get('content-range'), `bytes ${offset}-${offset + length - 1}/${total}`);
      assert.equal(response.headers.get('content-length'), String(length));
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, length);
      assert.equal(bytes[0], Math.floor(offset / chunkSize));
      assert.equal(bytes.at(-1), Math.floor(offset / chunkSize));
    }
    assert.deepEqual(upstreamRanges, [
      `bytes=0-${chunkSize - 1}`, `bytes=${chunkSize}-${2 * chunkSize - 1}`,
      'bytes=0-1', `bytes=${3 * chunkSize}-${4 * chunkSize - 1}`,
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
