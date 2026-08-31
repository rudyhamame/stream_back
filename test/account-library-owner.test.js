import test from 'node:test';
import assert from 'node:assert/strict';
import { accountOwnerId, canonicalSessionOwner } from '../account-library-owner.js';

const accountId = '64b64c50f0b7d15f02c8a001';

test('streaming resolves linked tokens to the shared account library owner', () => {
  const expected = accountOwnerId(accountId);
  assert.equal(canonicalSessionOwner({ ownerId: 'old-device-owner', deviceId: 'roku', accountId }), expected);
  assert.equal(canonicalSessionOwner({ ownerId: expected, accountId }), expected);
});
