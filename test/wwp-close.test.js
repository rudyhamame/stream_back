import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { reconcileWwpSession, endWwpSession, waitForWwpSession, wwpSyncToken } from '../wwp-sessions.js';

test('closing a shared session wakes both partner polls and leaves other sessions playing', async () => {
  const id = randomUUID(), other = randomUUID();
  const media = { key: 'shared', ownerId: 'host', sourceId: 'provider', kind: 'movie', id: 'movie', start: 0 };
  const session = reconcileWwpSession(id, media);
  const unrelated = reconcileWwpSession(other, { ...media, key: 'other' });
  const token = wwpSyncToken(session);
  const host = waitForWwpSession(id, token), guest = waitForWwpSession(id, token);
  endWwpSession(id);
  const results = await Promise.all([host, guest]);
  assert.ok(results.every(result => result.ended === true));
  assert.notEqual(wwpSyncToken(session), token);
  assert.equal(unrelated.ended, false);
  const endedToken = wwpSyncToken(session);
  endWwpSession(id);
  assert.equal(wwpSyncToken(session), endedToken);
});
