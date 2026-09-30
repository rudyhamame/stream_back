import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_roku';
const collectionName = 'stream_strategy_policy';
const defaults = Object.freeze({
  roku: { DIRECT: true, HLS_REMUX: true, HLS_AUDIO_TRANSCODE: false, HLS_VIDEO_TRANSCODE: false, HLS_FULL_TRANSCODE: false },
  browser: { DIRECT: true, HLS_REMUX: true, HLS_AUDIO_TRANSCODE: false, HLS_VIDEO_TRANSCODE: false, HLS_FULL_TRANSCODE: false },
  android: { DIRECT: true, HLS_REMUX: true, HLS_AUDIO_TRANSCODE: false, HLS_VIDEO_TRANSCODE: false, HLS_FULL_TRANSCODE: false },
});
let clientPromise;

async function collection() {
  if (!clientPromise) clientPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 5 })
    .connect().catch(error => { clientPromise = undefined; throw error; });
  return (await clientPromise).db(databaseName).collection(collectionName);
}

export async function getStreamStrategyPolicy() {
  const saved = await (await collection()).findOne({ _id: 'active' });
  const policy = {};
  for (const device of Object.keys(defaults)) {
    policy[device] = {};
    for (const strategy of Object.keys(defaults[device])) {
      policy[device][strategy] = typeof saved?.devices?.[device]?.[strategy] === 'boolean'
        ? saved.devices[device][strategy] : defaults[device][strategy];
    }
  }
  return { devices: policy, updatedAt: saved?.updatedAt || null };
}

export async function saveStreamStrategyPolicy(devices) {
  const normalized = {};
  for (const device of Object.keys(defaults)) {
    if (!devices?.[device] || typeof devices[device] !== 'object') throw new Error(`Missing ${device} strategy settings`);
    normalized[device] = {};
    for (const strategy of Object.keys(defaults[device])) {
      if (typeof devices[device][strategy] !== 'boolean') throw new Error(`Invalid ${device}/${strategy} setting`);
      normalized[device][strategy] = devices[device][strategy];
    }
    // An all-off policy intentionally blocks new playback.
  }
  const updatedAt = new Date();
  await (await collection()).updateOne({ _id: 'active' }, { $set: { devices: normalized, updatedAt } }, { upsert: true });
  return { devices: normalized, updatedAt };
}
