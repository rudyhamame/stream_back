import test from 'node:test';
import assert from 'node:assert/strict';
import { detectXtreamLanguage, displayDuration, rokuPage, rokuPagePayload } from '../roku-catalog-format.js';

test('Roku catalog paging clamps malformed requests and keeps a stable next-page boundary', () => {
  const req = { query: { page: '-3', limit: '9999' } };
  assert.deepEqual(rokuPage(req, 12), { page: 0, limit: 200, offset: 0 });
  const next = rokuPagePayload(Array.from({ length: 201 }, (_, index) => index), rokuPage(req, 12));
  assert.equal(next.items.length, 200);
  assert.equal(next.hasMore, true);
  assert.equal(next.total, 201);
});

test('Roku catalog formatting retains provider language and duration semantics', () => {
  assert.equal(detectXtreamLanguage({ title: 'Movie' }, 'AR | Films'), 'Arabic');
  assert.equal(detectXtreamLanguage({ title: 'فيلم' }, ''), 'Arabic');
  assert.equal(displayDuration('01:25'), '00:01:25');
  assert.equal(displayDuration(3661), '01:01:01');
});
