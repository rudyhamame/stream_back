# RH Streamer backend

Dedicated media data plane shared by two isolated Render deployments:

- `rh-stream-backend-tbm7.onrender.com` serves the Library frontend.
- `rh-stream-backend.onrender.com` serves Roku devices.

Each deployment runs its own FFmpeg jobs, capacity limits, HLS files, and
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
`MAX_ACTIVE_TRANSCODES`, `MAX_JOBS_PER_USER`, and `MAX_JOBS_PER_DEVICE`.
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

## Roku trick play

Seek thumbnails are generated lazily as persistent BIF v0 assets under
`TRICKPLAY_CACHE_ROOT` (default: the host temporary filesystem). Generation is
single-process by default, starts only while playback FFmpeg jobs are idle,
and never blocks VOD startup. Configure `TRICKPLAY_INTERVAL_SECONDS`,
`TRICKPLAY_MAX_CONCURRENT_JOBS`, `TRICKPLAY_PROCESS_TIMEOUT_MS`,
`TRICKPLAY_RETRY_MS`, `TRICKPLAY_CACHE_TTL_DAYS`, and
`TRICKPLAY_CACHE_MAX_BYTES`. Set `TRICKPLAY_CACHE_ROOT` to a mounted persistent
disk path if assets must survive host replacement or deployment.

## Render

The repository includes `render.yaml` and a Dockerfile. Configure
`MONGODB_URI` as a Render secret. Never commit `.env` or provider credentials.
