import { randomUUID } from 'node:crypto';
import { accountForLibraryOwner, allAccountDocuments, updateAccountLibrary } from './account-library-data.js';
import { accountOwnerId } from './account-library-owner.js';

const selectionFields = ['enabledKeys', 'enabledItems', 'archivedKeys', 'archivedItems'];

export function selectionFor(source, ownerId, accountOwner) {
  void accountOwner;
  const selection = source?.selections?.[String(ownerId)] || {};
  return Object.fromEntries(selectionFields.map(field => [field, Array.isArray(selection?.[field]) ? selection[field] : []]));
}

function sourcesForAccount(account) {
  const accountOwner = accountOwnerId(account._id);
  return (Array.isArray(account.providers) ? account.providers : []).map(source => {
    const selections = {};
    for (const profile of account.profiles || []) {
      const selection = profile.library?.savedSelections?.[String(source._id)];
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
  const fields = Object.fromEntries(selectionFields.map(field => [field, Array.isArray(selection?.[field]) ? selection[field] : []]));
  const located = await locateSource(id, accountOwner);
  if (!located) return null;
  await updateAccountLibrary(profileOwner, library => { library.savedSelections[String(id)] = fields; return library; });
  return publicXtreamSource({ ...located.source, selections: { [String(profileOwner)]: fields } }, profileOwner, accountOwner);
}

export async function deleteXtreamSource(id, ownerId) {
  const located = await locateSource(id, ownerId);
  if (!located) return false;
  const result = await located.collection.updateOne({ _id: located.account._id }, { $pull: { providers: { _id: located.source._id } }, $set: { updatedAt: new Date() } });
  return result.modifiedCount === 1;
}
