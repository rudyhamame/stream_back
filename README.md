# RH Streamer backend

Dedicated media data plane run as two isolated local processes:

- port `8788` serves the Library/Android frontend.
- port `8789` serves Roku devices.

Each process runs its own FFmpeg jobs, capacity limits, HLS files, and
provider connections. Its public surface is
deny-by-default and accepts only read-only health, direct playback, and HLS
delivery requests. Account, device, catalog, category, favorites, weather, and
playback-history calls deliberately return `404`; those belong to
`library_backend`.

The Streamer and Library services share the provider data and
`DEVICE_AUTH_SECRET` required to authorize playback, but they do not share a
public API role. Run `npm test` to verify the route boundary.

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

The default API address is `http://0.0.0.0:8787`. Check `GET /api/health`.

## Media resource controls

FFmpeg jobs are bounded by `MAX_TOTAL_FFMPEG_JOBS`, `MAX_ACTIVE_REMUX_JOBS`,
and `MAX_ACTIVE_TRANSCODES`. Separate viewers do not consume a single
account or device playback slot.
`MEDIA_JOB_IDLE_TIMEOUT_MS` controls abandoned HLS cleanup. Direct proxy
streams do not consume FFmpeg capacity and preserve byte-range requests.

Set `INTERNAL_DIAGNOSTICS_TOKEN` to enable `GET /internal/media-health`, then
send the token in `x-internal-token`. The endpoint never includes provider URLs
or credentials.

Run lifecycle tests with `npm test`. A provider-backed play/stop leak test is
available with:

```bash
MEDIA_TEST_TOKEN=... \
MEDIA_DEVICE_TOKEN=... \
MEDIA_TEST_PLAYBACK_PATH='/api/xtream/hls/.../master.m3u8' \
npm run test:media-leak
```

## Roku HLS startup

The OVH Roku service uses `node:24-trixie-slim` for FFmpeg 7.1 and sets
`HLS_VOD_INITIAL_BURST_SECONDS=12`, capped at 12 seconds in the server.
`HLS_VOD_READRATE=1` resumes real-time input pacing after this initial burst.
Each VOD startup, seek, and pipeline recovery gets the same bounded burst;
live inputs keep their provider pacing. Older FFmpeg deployments must leave
the burst at its default of zero.

Roku still waits for three complete, keyframe-safe segments. Its short HLS
manifest wait can extend while FFmpeg output time or completed-segment count
advances, with a 23-second absolute cap (existing longer transcode budgets
remain unchanged). Stalled jobs retain their inactivity timeout. Cancellation,
finished jobs, and a short final ENDLIST remain bounded.

Run `node scripts/check-hls-startup.js` inside the upgraded image to compare
cold startup and seeking against paced input without the burst. This offline
benchmark also checks segment decoding, opening keyframes, and steady pacing.

The Roku progress bar shows completed HLS media ahead of playback in yellow.
`GET /api/xtream/hls/:sourceId/:kind/:id/prepared-range` reads the existing
job only, under its account owner and active viewer. It reports the immutable
generation, restart base, currently advertised range start, and completed
range end. The server maintains a bounded duration cursor across rolling
manifests; it does not estimate the range from FFmpeg progress. The Roku
client ignores cancelled/older-URL requests and hides the range while a seek
is pending. Live channels and Direct playback do not show this VOD range.

## Self-hosted deployment

This service runs on the local machine only, managed by the systemd units in
`../deploy/`. Set `MONGODB_URI`, `DEVICE_AUTH_SECRET`, and `PUBLIC_BASE_URL` in
`.env`. Never commit `.env` or provider credentials.
