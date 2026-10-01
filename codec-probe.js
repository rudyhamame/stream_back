import { spawn } from 'node:child_process';
import { isProviderRefusal } from './provider-refusal.js';

const factText = value => /^(unknown|n\/a|none|undefined)$/i.test(String(value || '').trim()) ? '' : String(value || '').trim();
function normalizeFrameRate(value) {
  const raw = String(value || '').trim();
  const [n, d] = raw.split('/').map(Number);
  const fps = raw.includes('/') ? n / d : n;
  return Number.isFinite(fps) && fps > 0 ? String(Math.round(fps * 1000) / 1000) : '';
}

// One normalization contract for URL scans and already-fetched Live bytes.
export function normalizeProbe(probe, { deep = false } = {}) {
  if (!probe || typeof probe !== 'object') throw new Error('Invalid codec probe document');
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStreams = streams.filter(stream => stream.codec_type === 'video');
  // Some providers place a cover image before the actual video stream.
  // Base compatibility on a moving-picture stream whenever one exists.
  const video = videoStreams.find(stream => !stream.disposition?.attached_pic) || {};
  const audioStreams = streams.filter(stream => stream.codec_type === 'audio');
  const audio = audioStreams[0] || {};
  const metadata = {
    container: String(probe.format?.format_name || ''),
    containerSeconds: Math.max(0, Math.round(Number(probe.format?.duration) || 0)),
    probeBitrate: Math.max(0, Math.round(Number(probe.format?.bit_rate) || 0)),
    videoCodec: factText(video.codec_name),
    videoTracks: videoStreams.map((stream, index) => ({
      index: Number.isInteger(stream.index) ? stream.index : index, codec: factText(stream.codec_name), profile: factText(stream.profile),
      width: Number(stream.width) || 0, height: Number(stream.height) || 0,
      attachedPicture: Boolean(stream.disposition?.attached_pic),
    })),
    videoProfile: factText(video.profile),
    videoLevel: Math.max(0, Number(video.level) || 0),
    pixelFormat: factText(video.pix_fmt),
    videoBitDepth: Number(video.bits_per_raw_sample) || 0,
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    frameRate: String(normalizeFrameRate(video.avg_frame_rate) || normalizeFrameRate(video.r_frame_rate) || ''),
    audioCodec: factText(audio.codec_name),
    audioStreamStatus: audioStreams.length ? 'present' : deep ? 'absent' : 'unknown',
    audioProfile: String(audio.profile || ''),
    audioSampleRate: Number(audio.sample_rate) || 0,
    audioChannels: Number(audio.channels) || 0,
    audioChannelLayout: String(audio.channel_layout || ''),
    audioTracks: audioStreams.map((stream, index) => ({
      index: Number.isInteger(stream.index) ? stream.index : index, codec: factText(stream.codec_name), profile: factText(stream.profile),
      sampleRate: Number(stream.sample_rate) || 0, channels: Number(stream.channels) || 0,
      channelLayout: String(stream.channel_layout || ''),
    })),
    ...videoTimestampFacts(probe.frames),
  };
  return metadata;
}

// Decode-order frame timestamps, rather than packet DTS, expose broken
// presentation timing that stream copy would preserve in every HLS segment.
export function videoTimestampFacts(frames) {
  const times = (Array.isArray(frames) ? frames : [])
    .filter(frame => frame.media_type === 'video')
    .map(frame => Number(frame.best_effort_timestamp_time))
    .filter(Number.isFinite);
  if (times.length < 3) return {};
  return { videoTimingReliable: !times.some((time, index) => index > 0 && time <= times[index - 1]) };
}

export function missingProbeFacts(metadata = {}) {
  const fields = ['container', 'videoCodec', 'videoProfile', 'videoLevel', 'pixelFormat', 'width', 'height', 'frameRate'];
  // Missing audio is unknown unless a scan explicitly found no audio tracks.
  if (metadata.audioStreamStatus !== 'absent' || metadata.audioTracks?.length) fields.push('audioCodec', 'audioSampleRate', 'audioChannels');
  return fields.filter(key => !metadata[key] || (typeof metadata[key] === 'string' && !factText(metadata[key])));
}

export function mergeProbeFacts(first, next) {
  const merged = { ...first };
  for (const [key, value] of Object.entries(next)) {
    if (key === 'audioStreamStatus' && first.audioStreamStatus === 'present') continue;
    if (key === 'videoTimingReliable' && first.videoTimingReliable === false) continue;
    if (Array.isArray(value)) {
      // Merge tracks by stable stream index, not their order in a scan.
      const previous = first[key] || [];
      merged[key] = previous.map(track => ({ ...track }));
      for (const track of value) {
        const index = merged[key].findIndex(old => old.index === track.index);
        if (index < 0) merged[key].push(track);
        else merged[key][index] = mergeProbeFacts(merged[key][index], track);
      }
    } else if (!(key in merged) || (value !== '' && value !== undefined && value !== null && value !== 0)) merged[key] = value;
  }
  return merged;
}

const entries = 'frame=media_type,best_effort_timestamp_time:stream=index,codec_type,codec_name,profile,level,pix_fmt,bits_per_raw_sample,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,channel_layout:stream_disposition=attached_pic:format=format_name,duration,bit_rate';
export function runCodecScan(inputUrl, { deep = false, ffprobe = 'ffprobe', spawnProcess = spawn, timeoutMs = deep ? 65000 : 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(ffprobe, ['-v', 'error', '-rw_timeout', deep ? '60000000' : '12000000',
      '-probesize', deep ? '104857600' : '1048576', '-max_probe_packets', deep ? '10000' : '2500',
      '-analyzeduration', deep ? '30000000' : '3000000', '-read_intervals', '%+#120', '-show_frames', '-show_entries', entries, '-of', 'json', inputUrl],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errorOutput = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Codec probe timed out'));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk;
      // Never truncate JSON into an unparseable tail for multi-track media.
      if (Buffer.byteLength(output) > 1024 * 1024) {
        child.kill('SIGKILL');
        finish(new Error('Codec probe output exceeded limit'));
      }
    });
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-8000); });
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new Error(errorOutput.trim() || `ffprobe exited with ${code}`));
      try { finish(null, normalizeProbe(JSON.parse(output), { deep })); }
      catch { finish(new Error('Codec probe returned invalid metadata')); }
    });
  });
}

// Each attempt owns and clears its timer before the next scan begins. Failed
// deep scans preserve concrete initial facts; unknown facts never become guesses.
export async function inspectProviderCodecs(inputUrl, { scan = runCodecScan, ffprobe = 'ffprobe' } = {}) {
  let initial = {};
  try { initial = await scan(inputUrl, { ffprobe }); }
  catch (error) { if (isProviderRefusal(error.message)) throw error; }
  if (!missingProbeFacts(initial).length) return initial;
  try { return mergeProbeFacts(initial, await scan(inputUrl, { deep: true, ffprobe })); }
  catch (error) {
    if (!Object.keys(initial).length || isProviderRefusal(error.message)) throw error;
    return initial;
  }
}

export function probeCacheTtl(metadata, completeTtlMs) {
  return missingProbeFacts(metadata).length ? Math.min(5000, completeTtlMs) : completeTtlMs;
}
