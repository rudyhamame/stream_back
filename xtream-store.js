import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'rh_roku';
const collectionName = process.env.MONGODB_XTREAM_COLLECTION || 'xtream_sources';
let collectionPromise;

async function sourceCollection() {
  if (!collectionPromise) {
    collectionPromise = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 })
      .connect()
      .then(client => client.db(databaseName).collection(collectionName))
      .catch(error => {
        collectionPromise = undefined;
        throw error;
      });
  }
  return collectionPromise;
}

const selectionFields = ['enabledKeys', 'enabledItems', 'archivedKeys', 'archivedItems'];

export function selectionFor(source, ownerId, accountOwner) {
  const selection = ownerId && accountOwner && String(ownerId) !== String(accountOwner)
    ? source?.selections?.[String(ownerId)]
    : source;
  return Object.fromEntries(selectionFields.map(field => [field, Array.isArray(selection?.[field]) ? selection[field] : []]));
}

export function flattenSelection(sources, ownerId, accountOwner) {
  return (sources || []).map(source => ({ ...source, ...selectionFor(source, ownerId, accountOwner) }));
}

export function publicXtreamSource(source, ownerId, accountOwner) {
  if (!source) return null;
  const selected = selectionFor(source, ownerId, accountOwner);
  return {
    id: source._id,
    name: source.name,
    type: source.type || 'xtream',
    endpoint: source.baseUrl,
    hasCredentials: Boolean(source.username && source.password),
    enabledKeys: selected.enabledKeys,
    enabledItems: selected.enabledItems,
    archivedKeys: selected.archivedKeys,
    archivedItems: selected.archivedItems,
    selectedCount: selected.enabledKeys.length,
    archivedCount: selected.archivedKeys.length,
    updatedAt: source.updatedAt,
  };
}

export async function getXtreamSources(ownerId) {
  const filter = ownerId ? { ownerId } : {};
  const sources = await (await sourceCollection()).find(filter).sort({ name: 1, updatedAt: -1 }).toArray();
  return sources.map(publicXtreamSource);
}

export async function getXtreamSource(id, ownerId) {
  return (await sourceCollection()).findOne({ _id: id, ...(ownerId ? { ownerId } : {}) });
}

export async function getAllXtreamSources(ownerId) {
  return (await sourceCollection()).find(ownerId ? { ownerId } : {}).sort({ name: 1, updatedAt: -1 }).toArray();
}

export async function createXtreamSource({ name, type = 'xtream', baseUrl, username = '', password = '', ownerId }) {
  const source = {
    _id: randomUUID(), name, type, baseUrl, username, password, ownerId,
    enabledKeys: [], enabledItems: [], archivedKeys: [], archivedItems: [], createdAt: new Date(), updatedAt: new Date(),
  };
  await (await sourceCollection()).insertOne(source);
  return publicXtreamSource(source);
}

export async function updateXtreamSource(id, changes, ownerId) {
  const result = await (await sourceCollection()).findOneAndUpdate(
    { _id: id, ...(ownerId ? { ownerId } : {}) },
    { $set: { ...changes, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return publicXtreamSource(result?.value || result);
}

export async function updateXtreamSelection(id, selection, accountOwner, profileOwner = accountOwner) {
  if (profileOwner && String(profileOwner) !== String(accountOwner) && !/^[a-f0-9]{64}$/i.test(String(profileOwner))) return null;
  const fields = Object.fromEntries(selectionFields.map(field => [field, Array.isArray(selection?.[field]) ? selection[field] : []]));
  const ownerPath = String(profileOwner || accountOwner) === String(accountOwner)
    ? fields
    : Object.fromEntries(selectionFields.map(field => [`selections.${String(profileOwner)}.${field}`, fields[field]]));
  const result = await (await sourceCollection()).findOneAndUpdate(
    { _id: id, ...(accountOwner ? { ownerId: accountOwner } : {}) },
    { $set: { ...ownerPath, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return publicXtreamSource(result?.value || result, profileOwner, accountOwner);
}

export async function deleteXtreamSource(id, ownerId) {
  const result = await (await sourceCollection()).deleteOne({ _id: id, ...(ownerId ? { ownerId } : {}) });
  return result.deletedCount === 1;
}
