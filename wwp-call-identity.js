import { createHash } from 'node:crypto';

// A stream ticket authorizes the host's media, but the invited caller is a
// different signaling participant. Never use media ownership as peer identity.
export function wwpCallParticipantId(deviceOwnerId, ticket, token) {
  // Older call pages send the same signed ticket in both credential fields.
  // It can also decode as a device token, so the validated media ticket wins.
  if (ticket?.ownerId && token) return `invite:${createHash('sha256').update(token).digest('hex')}`;
  return deviceOwnerId ? `account:${deviceOwnerId}` : null;
}
