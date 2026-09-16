import { createHash } from 'node:crypto';

export function accountOwnerId(accountId) {
  return createHash('sha256').update(`account:${String(accountId)}`).digest('hex');
}

export function profileOwnerId(accountId, profileId) {
  return createHash('sha256').update(`account:${String(accountId)}:profile:${String(profileId)}`).digest('hex');
}

export function canonicalSessionOwner(session) {
  const accountId = String(session?.accountId || '');
  if (!/^[a-f0-9]{24}$/i.test(accountId)) return session?.ownerId || null;
  // A device token for a selected profile carries that profile's ownerId
  // (accountOwnerId for the default profile, profileOwnerId otherwise). Trust
  // it so this streamer scopes favorites / playback / selection per profile,
  // matching library_backend. Tokens issued before profiles existed have no
  // profileId and fall through to the account-wide owner.
  if (session?.profileId && session?.ownerId) return String(session.ownerId);
  return accountOwnerId(accountId);
}
