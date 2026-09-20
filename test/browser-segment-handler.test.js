import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

// Execute the production route with isolated I/O: importing server.js would
// start a real listener and connect to the production account database.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const route = source.slice(source.indexOf("app.get('/api/xtream/hls/:sourceId/:kind/:id/:segment'"), source.indexOf("app.get('/api/xtream/roku/:sourceId/:kind/:id'"));

test('missing HLS segment returns 404 without crashing and never substitutes a newer generation', async () => {
  let handler;
  let fallbackLookups = 0;
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const job = { directory: '/tmp/test-generation', generationId: 'old', finished: true, userId: 'owner', activeRequests: 0 };
  const context = {
    app: { get: (_path, callback) => { handler = callback; } }, path,
    fs: { access: async () => { throw missing; }, readdir: async () => [] },
    console: { warn() {}, error() {} },
    hlsStartSeconds: () => 0, playbackTarget: () => ({ key: 'browser' }), requestedHlsFallback: () => '', rokuHlsKey: () => 'key',
    hlsGenerationJobs: new Map([['old', job]]),
    mediaJobs: { get: () => { fallbackLookups++; return job; }, touch() {} },
    resolveStreamTicket: () => null, requestStreamTicket: () => '', getWwpSession: () => null,
    mediaOwner: () => 'owner', mediaIdentity: () => ({ viewerId: 'viewer' }),
    Date, setTimeout,
  };
  vm.runInNewContext(route, context);
  const response = () => ({ status: 0, once() {}, sendStatus(status) { this.status = status; }, headersSent: false, destroyed: false });
  const req = { params: { kind: 'movie', id: '1', segment: 'segment-000001.ts' }, query: { generation: 'old' } };
  const res = response();
  await handler(req, res);
  assert.equal(res.status, 404);
  assert.equal(fallbackLookups, 0);
  context.hlsGenerationJobs.clear();
  // Jump the bounded wait forward for the absent-generation case.
  let now = 0;
  context.Date = { now: () => (now += 2000) };
  const absent = response();
  await handler(req, absent);
  assert.equal(absent.status, 404);
  assert.equal(fallbackLookups, 0);
});
