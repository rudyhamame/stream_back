import test from 'node:test';
import assert from 'node:assert/strict';
import { checkInternetConnection } from '../internet-health.js';

test('treats any public HTTP response as an available internet path', async () => {
  const result = await checkInternetConnection({
    fetchImpl: async () => ({ status: 302 }),
    url: 'https://connectivity.example.test/check',
  });
  assert.equal(result.online, true);
  assert.equal(result.status, 302);
});

test('reports offline when the public connectivity request cannot connect', async () => {
  const result = await checkInternetConnection({
    fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENETUNREACH' } }); },
    url: 'https://connectivity.example.test/check',
  });
  assert.equal(result.online, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, 'ENETUNREACH');
});

