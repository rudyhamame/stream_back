import { randomUUID } from 'node:crypto';
import { accountForLibraryOwner, allAccountDocuments, updateAccountLibrary } from './account-library-data.js';
import { accountOwnerId } from './account-library-owner.js';
import { xtreamProviderUrl } from './xtream.js';

const savedKinds = ['series', 'movies', 'live'];
const kindFor = value => String(value || '').toLowerCase() === 'channel' || String(value || '').toLowerCase() === 'live' ? 'live' : (String(value || '').toLowerCase() === 'movie' || String(value || '').toLowerCase() === 'movies' ? 'movies' : 'series');
const identityKindFor = bucket => bucket === 'live' ? 'channel' : bucket === 'movies' ? 'movie' : 'series';
const normalizeIdentity = (entry, bucket) => entry && typeof entry === 'object' && entry.sourceId != null && entry.itemId != null
  ? { sourceId: String(entry.sourceId), kind: String(entry.kind || identityKindFor(bucket)), itemId: String(entry.itemId) }
  : null;
const savedShape = value => Object.fromEntries(savedKinds.map(bucket => [bucket,
  (Array.isArray(value?.[bucket]) ? value[bucket] : []).map(entry => normalizeIdentity(entry, bucket)).filter(Boolean),
]));
function sourceUrl(source, kind, id, extension = '') { return xtreamProviderUrl(source, kind === 'live' ? 'channel' : (kind === 'movies' ? 'movie' : 'series'), id, extension); }
function identitiesForSource(source, saved) {
  const result = savedShape(saved);
  for (const bucket of savedKinds) result[bucket] = result[bucket].filter(identity => identity.sourceId === String(source._id));
  return result;
}
function itemFromIdentity(identity) {
  const kind = identity.kind === 'channel' ? 'channel' : identity.kind === 'movie' ? 'movie' : 'series';
  return { key: `${kind}:${identity.itemId}`, id: identity.itemId, kind, sourceId: identity.sourceId, title: identity.itemId };
}

export function selectionFor(source, ownerId, accountOwner) {
  void accountOwner;
  const raw = source?.selections?.[String(ownerId)] || source?.savedSelections || {};
  if (!Array.isArray(raw.series) && !Array.isArray(raw.movies) && !Array.isArray(raw.live) && Array.isArray(raw.enabledKeys)) return { enabledKeys: raw.enabledKeys, enabledItems: raw.enabledItems || [], archivedKeys: raw.archivedKeys || [], archivedItems: raw.archivedItems || [] };
  const saved = identitiesForSource(source, raw);
  const enabledItems = savedKinds.flatMap(kind => saved[kind].map(itemFromIdentity));
  return { enabledKeys: enabledItems.map(item => item.key), enabledItems, archivedKeys: [], archivedItems: [], savedSelections: saved };
}

function sourcesForAccount(account) {
  const accountOwner = accountOwnerId(account._id);
  return (Array.isArray(account.providers) ? account.providers : []).map(source => {
    const selections = {};
    for (const profile of account.profiles || []) {
      const selection = profile.library?.savedSelections;
      if (selection) selections[String(profile.ownerId)] = selection;
    }
    return { ...source, ownerId: accountOwner, selections, _accountId: account._id };
  });
}

async function locateSource(id, ownerId = '') {
  const rows = ownerId ? [await accountForLibraryOwner(ownerId)] : await allAccountDocuments();
  for (const row of rows) {
    const source = (row.account.providers || []).find(item => String(item._id) === String(id));
    if (source) return { ...row, source, accountOwner: accountOwnerId(row.account._id) };
  }
  return null;
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
  const sources = ownerId ? sourcesForAccount((await accountForLibraryOwner(ownerId)).account) : (await allAccountDocuments()).flatMap(row => sourcesForAccount(row.account));
  return sources.map(source => publicXtreamSource(source, ownerId || source.ownerId, source.ownerId));
}

export async function getXtreamSource(id, ownerId) {
  const located = await locateSource(id, ownerId);
  return located ? sourcesForAccount(located.account).find(item => String(item._id) === String(id)) || null : null;
}

export async function getAllXtreamSources(ownerId) {
  if (ownerId) return sourcesForAccount((await accountForLibraryOwner(ownerId)).account);
  return (await allAccountDocuments()).flatMap(row => sourcesForAccount(row.account));
}

export async function createXtreamSource({ name, type = 'xtream', baseUrl, username = '', password = '', ownerId }) {
  const { collection, account } = await accountForLibraryOwner(ownerId);
  const source = { _id: randomUUID(), name, type, baseUrl, username, password, createdAt: new Date(), updatedAt: new Date() };
  await collection.updateOne({ _id: account._id }, { $push: { providers: source }, $set: { updatedAt: new Date() } });
  return publicXtreamSource({ ...source, selections: {} }, ownerId, ownerId);
}

export async function updateXtreamSource(id, changes, ownerId) {
  const located = await locateSource(id, ownerId);
  if (!located) return null;
  const { providerURL: _providerURL, providerUrl: _providerUrl, ...safeChanges } = changes || {};
  const next = { ...located.source, ...safeChanges, _id: located.source._id, updatedAt: new Date() };
  await located.collection.updateOne({ _id: located.account._id, 'providers._id': located.source._id }, { $set: { 'providers.$': next, updatedAt: new Date() } });
  return publicXtreamSource({ ...next, selections: {} }, ownerId || located.accountOwner, located.accountOwner);
}

export async function updateXtreamSelection(id, selection, accountOwner, profileOwner = accountOwner) {
  if (!accountOwner || !profileOwner) return null;
  const located = await locateSource(id, accountOwner);
  if (!located) return null;
  const prior = savedShape((await accountForLibraryOwner(profileOwner)).account?.profiles?.find(profile => String(profile.ownerId) === String(profileOwner))?.library?.savedSelections);
  const next = savedShape(prior);
  for (const kind of savedKinds) next[kind] = next[kind].filter(identity => identity.sourceId !== String(located.source._id));
  const items = Array.isArray(selection?.enabledItems) ? selection.enabledItems : [];
  for (const item of items) {
    const kind = kindFor(item.kind);
    const itemId = String(item.id || item.itemId || '');
    if (itemId) next[kind].push({ sourceId: String(located.source._id), kind: identityKindFor(kind), itemId });
  }
  await updateAccountLibrary(profileOwner, library => { library.savedSelections = next; return library; });
  return publicXtreamSource({ ...located.source, selections: { [String(profileOwner)]: next } }, profileOwner, accountOwner);
}

export async function deleteXtreamSource(id, ownerId) {
  const located = await locateSource(id, ownerId);
  if (!located) return false;
  const result = await located.collection.updateOne({ _id: located.account._id }, { $pull: { providers: { _id: located.source._id } }, $set: { updatedAt: new Date() } });
  return result.modifiedCount === 1;
}
