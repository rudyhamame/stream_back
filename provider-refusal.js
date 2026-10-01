// FFmpeg stderr contains progress counters, bitrates and timestamps as well
// as diagnostics. A bare number such as frame=403 is not an HTTP refusal.
export function isProviderRefusal(value) {
  const text = String(value || '');
  return /\bserver returned\s+4\d\d\b|\bHTTP\s+(?:error\s+|status(?:\s+code)?\s*[:=]?\s*)?4\d\d\b|\bforbidden\b|\baccess denied\b|\btoo many requests\b|\b(?:connection limit|too many connections)\b/i.test(text);
}
