import { MongoClient } from 'mongodb';
import { accountOwnerId } from './account-library-owner.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const rokuDb = process.env.MONGODB_DB || 'rh_roku';
const generalDb = process.env.MONGODB_GENERAL_DB || 'rh_general';
let clientPromise;

async function accountCollections() {
  if (!clientPromise) clientPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10, maxIdleTimeMS: 30_000 }).connect().catch(error => { clientPromise = undefined; throw error; });
  const client = await clientPromise;
  return [client.db(rokuDb).collection('identity'), client.db(generalDb).collection('identity')];
}

export async function allAccountDocuments() {
  const rows = [];
  for (const collection of await accountCollections()) {
    for (const account of await collection.find({}).toArray()) rows.push({ collection, account });
  }
  return rows;
}

export async function accountForLibraryOwner(ownerId) {
  const key = String(ownerId || '');
  if (!key) throw new Error('Account library owner is required');
  for (const collection of await accountCollections()) {
    const account = await collection.findOne({ $or: [{ ownerId: key }, { 'profiles.ownerId': key }] });
    if (account) return { collection, account };
  }
  for (const collection of await accountCollections()) {
    const rows = await collection.find({}, { projection: { _id: 1 } }).toArray();
    const match = rows.find(row => accountOwnerId(row._id) === key);
    if (match) return { collection, account: await collection.findOne({ _id: match._id }) };
  }
  throw Object.assign(new Error('Account library not found'), { status: 404 });
}

function normalizedAccountLibrary(library) {
  const withoutProviderUrls = value => {
    if (Array.isArray(value)) return value.map(withoutProviderUrls);
    if (!value || typeof value !== 'object') return value;
    if (value instanceof Date || value._bsontype) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['providerURL', 'providerUrl'].includes(key)).map(([key, child]) => [key, withoutProviderUrls(child)]));
  };
  const rawHistory = library?.streaming_history || {};
  const rows = Array.isArray(rawHistory)
    ? rawHistory
    : [
      ...(Array.isArray(rawHistory.series) ? rawHistory.series.flatMap(group =>
        (Array.isArray(group?.episodes) ? group.episodes : []).map(episode => ({
          ...episode,
          providerIdentity: {
            ...group.providerIdentity,
            ...episode?.providerIdentity,
            kind: 'series',
            seriesId: episode?.providerIdentity?.seriesId || group.providerIdentity?.seriesId || '',
          },
        }))
      ) : []),
      ...(Array.isArray(rawHistory.episodes) ? rawHistory.episodes : []),
      ...(Array.isArray(rawHistory.movies) ? rawHistory.movies : []),
      ...(Array.isArray(rawHistory.live) ? rawHistory.live : []),
    ];
  const historyByIdentity = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const identity = row.providerIdentity || (row.providerURL && typeof row.providerURL === 'object' ? row.providerURL : {});
    const sourceId = String(identity.sourceId || row.sourceId || '');
    const itemId = String(identity.itemId || row.itemId || '');
    if (!sourceId || !itemId) continue;
    const rawKind = String(identity.kind || row.kind || 'movie').toLowerCase();
    const kind = ['live', 'channel'].includes(rawKind) ? 'channel' : (['series', 'episode'].includes(rawKind) ? 'series' : 'movie');
    const { itemId: _itemId, kind: _kind, sourceId: _sourceId, seriesId: _seriesId, providerIdentity: _providerIdentity, providerURL: _providerURL, providerUrl: _providerUrl, ...metadata } = row;
    const normalized = {
      ...(kind === 'movie' || kind === 'series' ? { lastWatched: String(row.lastWatched || '00:00:00') } : {}),
      providerIdentity: {
        itemId,
        kind,
        sourceId,
        ...(kind === 'series' && (identity.seriesId || row.seriesId) ? { seriesId: String(identity.seriesId || row.seriesId) } : {}),
      },
    };
    const key = `${sourceId}:${kind}:${itemId}`;
    const previous = historyByIdentity.get(key);
    if (!previous || new Date(normalized.updatedAt || 0) >= new Date(previous.updatedAt || 0)) historyByIdentity.set(key, normalized);
  }
  const streamingHistory = { series: [], movies: [], live: [] };
  for (const row of historyByIdentity.values()) {
    const identity = row.providerIdentity;
    if (identity.kind === 'channel') streamingHistory.live.push(row);
    else if (identity.kind === 'series') {
      const seriesId = identity.seriesId || '';
      let group = streamingHistory.series.find(entry => entry.providerIdentity.sourceId === identity.sourceId && entry.providerIdentity.seriesId === seriesId);
      if (!group) {
        group = { providerIdentity: { sourceId: identity.sourceId, kind: 'series', seriesId }, episodes: [] };
        streamingHistory.series.push(group);
      }
      group.episodes.push({ ...row, providerIdentity: { itemId: identity.itemId } });
    } else streamingHistory.movies.push(row);
  }
  return {
    favorites: Array.isArray(library?.favorites) ? withoutProviderUrls(library.favorites) : [],
    savedSelections: {
      series: Array.isArray(library?.savedSelections?.series) ? withoutProviderUrls(library.savedSelections.series) : [],
      movies: Array.isArray(library?.savedSelections?.movies) ? withoutProviderUrls(library.savedSelections.movies) : [],
      live: Array.isArray(library?.savedSelections?.live) ? withoutProviderUrls(library.savedSelections.live) : [],
    },
    streaming_history: streamingHistory,
  };
}

function selectedProfile(account, ownerId) {
  const profiles = Array.isArray(account.profiles) ? account.profiles : [];
  return profiles.find(row => row.ownerId === String(ownerId));
}

export async function updateAccountLibrary(ownerId, change) {
  const { collection, account } = await accountForLibraryOwner(ownerId);
  const profile = selectedProfile(account, ownerId);
  if (!profile) throw Object.assign(new Error('Profile library not found'), { status: 404 });
  const next = await change(structuredClone(normalizedAccountLibrary(profile.library)));
  if (!next) return null;
  await collection.updateOne(
    { _id: account._id, 'profiles.id': profile.id },
    { $set: { 'profiles.$.library': normalizedAccountLibrary(next), 'profiles.$.updatedAt': new Date(), updatedAt: new Date() } },
  );
  return next;
}
