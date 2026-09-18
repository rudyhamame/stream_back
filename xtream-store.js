import { randomUUID } from 'node:crypto';
import { accountForLibraryOwner, allAccountDocuments, updateAccountLibrary } from './account-library-data.js';
import { accountOwnerId } from './account-library-owner.js';
import { xtreamProviderUrl } from './xtream.js';

const savedKinds = ['series', 'movies', 'live'];
const kindFor = value => String(value || '').toLowerCase() === 'channel' || String(value || '').toLowerCase() === 'live' ? 'live' : (String(value || '').toLowerCase() === 'movie' || String(value || '').toLowerCase() === 'movies' ? 'movies' : 'series');
const savedShape = value => {
  const next = Object.fromEntries(savedKinds.map(kind => [kind, Array.isArray(value?.[kind]) ? value[kind].map(String).filter(Boolean) : []]));
  if (!savedKinds.some(kind => next[kind].length) && Array.isArray(value?.enabledItems)) for (const item of value.enabledItems) {
    const url = String(item?.providerUrl || ''); if (url) next[kindFor(item.kind)].push(url);
  }
  return next;
};
function sourceUrl(source, kind, id, extension = '') { return xtreamProviderUrl(source, kind === 'live' ? 'channel' : kind.slice(0, -1), id, extension); }
function urlsForSource(source, saved) {
  const result = savedShape(saved);
  for (const kind of savedKinds) result[kind] = result[kind].filter(url => String(url).startsWith(String(source.baseUrl || '').replace(/\/$/, '') + '/'));
  return result;
}
function itemFromUrl(url, source) {
  const text = String(url || '');
  const match = text.match(/\/(series|movie|live)\/[^/]+\/[^/]+\/([^/?#]+?)(?:\.[a-z0-9]+)?(?:[?#].*)?$/i);
  if (!match) return null;
  const kind = match[1].toLowerCase() === 'live' ? 'channel' : match[1].toLowerCase();
  const id = match[2];
  return { key: `${kind}:${id}`, id, kind, providerUrl: text, sourceId: String(source._id), title: id, extension: text.split('.').pop()?.split('?')[0] || '' };
}

export function selectionFor(source, ownerId, accountOwner) {
  void accountOwner;
  const raw = source?.selections?.[String(ownerId)] || source?.savedSelections || {};
  if (!Array.isArray(raw.series) && !Array.isArray(raw.movies) && !Array.isArray(raw.live) && Array.isArray(raw.enabledKeys)) return { enabledKeys: raw.enabledKeys, enabledItems: raw.enabledItems || [], archivedKeys: raw.archivedKeys || [], archivedItems: raw.archivedItems || [] };
  const saved = urlsForSource(source, raw);
  const enabledItems = savedKinds.flatMap(kind => saved[kind].map(url => itemFromUrl(url, source)).filter(Boolean));
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
  const next = { ...located.source, ...changes, _id: located.source._id, updatedAt: new Date() };
  await located.collection.updateOne({ _id: located.account._id, 'providers._id': located.source._id }, { $set: { 'providers.$': next, updatedAt: new Date() } });
  return publicXtreamSource({ ...next, selections: {} }, ownerId || located.accountOwner, located.accountOwner);
}

export async function updateXtreamSelection(id, selection, accountOwner, profileOwner = accountOwner) {
  if (!accountOwner || !profileOwner) return null;
  const located = await locateSource(id, accountOwner);
  if (!located) return null;
  const prior = savedShape((await accountForLibraryOwner(profileOwner)).account?.profiles?.find(profile => String(profile.ownerId) === String(profileOwner))?.library?.savedSelections);
  const next = savedShape(prior);
  for (const kind of savedKinds) next[kind] = next[kind].filter(url => !String(url).startsWith(String(located.source.baseUrl || '').replace(/\/$/, '') + '/'));
  const items = Array.isArray(selection?.enabledItems) ? selection.enabledItems : [];
  for (const item of items) {
    const kind = kindFor(item.kind);
    const url = String(item.providerUrl || sourceUrl(located.source, kind, item.id, item.extension));
    if (url) next[kind].push(url);
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
