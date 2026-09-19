import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const accountLibraryData = readFileSync(new URL('../account-library-data.js', import.meta.url), 'utf8');
const deviceSessions = readFileSync(new URL('../device-sessions.js', import.meta.url), 'utf8');

test('streamer reads nested accounts from identity in both account databases', () => {
  assert.match(accountLibraryData, /client\.db\(rokuDb\)\.collection\('identity'\)/);
  assert.match(accountLibraryData, /client\.db\(generalDb\)\.collection\('identity'\)/);
  assert.doesNotMatch(accountLibraryData, /MONGODB_ACCOUNT_COLLECTION|collection\(['"]accounts['"]\)/);
});

test('streamer session operations use the nested identity account schema', () => {
  assert.match(deviceSessions, /const accountCollectionName = 'identity';/);
  assert.doesNotMatch(deviceSessions, /MONGODB_ACCOUNT_COLLECTION|accountCollectionName = ['"]accounts['"]/);
});
