import { MongoClient } from 'mongodb';
import { accountOwnerId } from './account-library-owner.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const rokuDb = process.env.MONGODB_DB || 'rh_roku';
const generalDb = process.env.MONGODB_GENERAL_DB || 'rh_general';
let clientPromise;

async function accountCollections() {
  if (!clientPromise) clientPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 }).connect().catch(error => { clientPromise = undefined; throw error; });
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
  return {
    favorites: Array.isArray(library?.favorites) ? withoutProviderUrls(library.favorites) : [],
    savedSelections: {
      series: Array.isArray(library?.savedSelections?.series) ? withoutProviderUrls(library.savedSelections.series) : [],
      movies: Array.isArray(library?.savedSelections?.movies) ? withoutProviderUrls(library.savedSelections.movies) : [],
      live: Array.isArray(library?.savedSelections?.live) ? withoutProviderUrls(library.savedSelections.live) : [],
    },
    series_last_watched: Array.isArray(library?.series_last_watched) ? withoutProviderUrls(library.series_last_watched) : [],
    last_kinds_watched: {
      episode: withoutProviderUrls(library?.last_kinds_watched?.episode || null),
      movie: withoutProviderUrls(library?.last_kinds_watched?.movie || null),
      live: withoutProviderUrls(library?.last_kinds_watched?.live || null),
    },
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
