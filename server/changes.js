import { stableJson } from './store.js';
import { historyActivity } from './history-activity.js';

const atomContent = atom => Object.fromEntries(Object.entries(atom).filter(([key]) => !['index', 'x', 'y', 'z'].includes(key)));
const bondContent = bond => ({ ...Object.fromEntries(Object.entries(bond).filter(([key]) => key !== 'index')), order: bond.aromatic ? 'aromatic' : bond.order });
const coordinates = atom => ({ x: atom.x ?? null, y: atom.y ?? null, z: atom.z ?? null });

function difference(before = [], after = [], content = value => value) {
  const old = new Map(before.map(value => [value.id, value]));
  const current = new Map(after.map(value => [value.id, value]));
  return {
    added: after.filter(value => !old.has(value.id)),
    removed: before.filter(value => !current.has(value.id)),
    changed: after.filter(value => old.has(value.id) && stableJson(content(old.get(value.id))) !== stableJson(content(value)))
      .map(value => ({ id: value.id, before: old.get(value.id), after: value })),
    retained: after.filter(value => old.has(value.id)).map(value => value.id)
  };
}

export function moleculeDifference(before, after) {
  const atoms = difference(before?.atoms, after?.atoms, atomContent);
  const bonds = difference(before?.bonds, after?.bonds, bondContent);
  const positions = difference(before?.atoms, after?.atoms, coordinates);
  // Derive from snapshots, including undo. Relative cis/trans tags are not absolute E/Z.
  const stereoChanges = atoms.changed.filter(c => c.before.cip !== c.after.cip || c.before.stereo !== c.after.stereo)
    .map(c => ({ kind: 'tetrahedral', atomId: c.id,
      before: { configuration: c.before.cip ?? null, tag: c.before.stereo }, after: { configuration: c.after.cip ?? null, tag: c.after.stereo } }));
  for (const c of bonds.changed.filter(c => c.before.stereo !== c.after.stereo || stableJson(c.before.stereoAtoms) !== stableJson(c.after.stereoAtoms))) {
    stereoChanges.push({ kind: 'doubleBond', bondId: c.id, before: { tag: c.before.stereo, stereoAtoms: c.before.stereoAtoms ?? [] }, after: { tag: c.after.stereo, stereoAtoms: c.after.stereoAtoms ?? [] } });
  }
  return {
    stereoChanges,
    addedAtoms: atoms.added, removedAtoms: atoms.removed, changedAtoms: atoms.changed,
    addedBonds: bonds.added, removedBonds: bonds.removed, changedBonds: bonds.changed,
    movedAtoms: positions.changed.map(({ id, before: a, after: b }) => ({ id, before: coordinates(a), after: coordinates(b) })),
    retainedAtomIds: atoms.retained, retainedBondIds: bonds.retained,
    identityPreserved: !before || !after ? null : atoms.retained.length > 0,
    beforeSmiles: before?.smiles ?? null, afterSmiles: after?.smiles ?? null,
    ...(stableJson(before?.depictionAdjustment) !== stableJson(after?.depictionAdjustment)
      ? { depictionAdjustment: { before: before?.depictionAdjustment ?? null, after: after?.depictionAdjustment ?? null } } : {})
  };
}

export function summarizeChanges(document, { sinceRevision = 0, limit = 50, activity = false } = {}) {
  if (!Number.isSafeInteger(sinceRevision) || sinceRevision < 0 || sinceRevision > document.revision || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw Object.assign(new Error('sinceRevision/limit 无效。'), { code: 'VALIDATION' });
  }
  const history = document.history.filter(entry => entry.revision > sinceRevision);
  const chosen = history.slice(0, limit);
  const events = chosen.map(entry => {
    const before = entry.before?.objects || {}, after = entry.after?.objects || {};
    const objects = [];
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const old = before[id], current = after[id];
      if (old && current && stableJson(old) === stableJson(current)) continue;
      const kind = current?.kind ?? old?.kind;
      objects.push({ objectId: id, kind, title: current?.title ?? old?.title, action: !old ? 'added' : !current ? 'removed' : 'updated',
        beforeVersion: old?.version ?? null, afterVersion: current?.version ?? null,
        ...(kind === 'molecule' ? { moleculeDelta: moleculeDifference(old?.data, current?.data) } : { beforeData: old?.data ?? null, afterData: current?.data ?? null }) });
    }
    const relationChanges = difference(Object.values(entry.before?.relations || {}), Object.values(entry.after?.relations || {}));
    const viewChanges = difference(Object.values(entry.before?.views || {}), Object.values(entry.after?.views || {}));
    const event = { revision: entry.revision, operationId: entry.operationId, actor: entry.actor, type: entry.type, summary: entry.summary,
      ...(stableJson(entry.before?.schemeLayout)!==stableJson(entry.after?.schemeLayout)?{schemeLayout:{before:entry.before.schemeLayout??null,after:entry.after.schemeLayout??null}}:{}),
      objects, relations: { added: relationChanges.added, removed: relationChanges.removed, changed: relationChanges.changed },
      views: { added: viewChanges.added, removed: viewChanges.removed, changed: viewChanges.changed } };
    return activity ? historyActivity(entry, event) : event;
  });
  return { documentId: document.id, currentRevision: document.revision, sinceRevision,
    throughRevision: chosen.at(-1)?.revision ?? sinceRevision, hasMore: history.length > chosen.length, events };
}
