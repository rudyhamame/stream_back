// Use the input header, never an output progress timestamp. No extra provider
// connection is required to learn the complete duration during playback.
export function inputDurationSeconds(header) {
  const input = String(header).split(/Output #\d/)[0];
  const match = input.match(/Duration:\s*(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)/);
  if (!match) return 0;
  return Math.round(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
}
