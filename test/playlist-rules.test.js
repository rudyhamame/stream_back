import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlaylistRules, normalizePlaylistRules, providerLineIdentity } from '../playlist-rules.js';

test('playlist rules default to disabled (except the hard one-stream-per-provider rule) and clamp numeric values', () => {
  const defaults = defaultPlaylistRules();
  assert.ok(Object.entries(defaults).every(([name, rule]) => name === 'maxConcurrentStreams' || rule.enabled === false));
  assert.equal(defaults.maxConcurrentStreams.enabled, true);
  assert.equal(defaults.maxConcurrentStreams.limit, 1);
});

test('strictSharedLine hard-forces maxConcurrentStreams to a single slot, overriding any configured limit', () => {
  const rules = normalizePlaylistRules({
    strictSharedLine: { enabled: true },
    maxConcurrentStreams: { enabled: false, limit: 99 },
  });
  assert.equal(rules.strictSharedLine.enabled, true);
  assert.equal(rules.maxConcurrentStreams.enabled, true);
  assert.equal(rules.maxConcurrentStreams.limit, 1);
});

test('strictSharedLine defaults off, leaving maxConcurrentStreams at its normal per-source behavior', () => {
  const rules = normalizePlaylistRules({});
  assert.equal(rules.strictSharedLine.enabled, false);
});

test('providerLineIdentity groups two different source documents on the same provider line together', () => {
  const ownerA = { _id: 'source-a', baseUrl: 'http://line.example.com/', username: 'Cea86e90Da' };
  const ownerB = { _id: 'source-b', baseUrl: 'http://LINE.example.com', username: 'cea86e90da' };
  const different = { _id: 'source-c', baseUrl: 'http://line.example.com', username: 'someone-else' };
  assert.equal(providerLineIdentity(ownerA), providerLineIdentity(ownerB));
  assert.notEqual(providerLineIdentity(ownerA), providerLineIdentity(different));
});
