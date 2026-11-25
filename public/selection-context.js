// Stable graph IDs only. These helpers have no DOM, network or storage side effects.
export const emptySelection = () => ({ atomIds: [], bondIds: [] });
const unique = values => [...new Set(values || [])];
export function normalizeSelection(selection, graph) {
  const atoms = new Set(graph.atoms.map(atom => atom.id)), bonds = new Set(graph.bonds.map(bond => bond.id));
  return { atomIds: unique(selection?.atomIds).filter(id => atoms.has(id)), bondIds: unique(selection?.bondIds).filter(id => bonds.has(id)) };
}
export function singleSelection(selection) {
  if (selection.atomIds.length + selection.bondIds.length !== 1) return null;
  return selection.atomIds.length ? { kind: 'atom', id: selection.atomIds[0] } : { kind: 'bond', id: selection.bondIds[0] };
}
export function toggleSelection(selection, kind, id) {
  const key = kind === 'atom' ? 'atomIds' : 'bondIds';
  return { ...structuredClone(selection), [key]: selection[key].includes(id) ? selection[key].filter(value => value !== id) : [...selection[key], id] };
}
export function unionSelection(left, right) {
  return { atomIds: unique([...left.atomIds, ...right.atomIds]), bondIds: unique([...left.bondIds, ...right.bondIds]) };
}
export function rectangleSelection(graph, start, end) {
  const inside = atom => atom.x >= Math.min(start.x, end.x) && atom.x <= Math.max(start.x, end.x) && atom.y >= Math.min(start.y, end.y) && atom.y <= Math.max(start.y, end.y);
  const atomIds = graph.atoms.filter(inside).map(atom => atom.id), ids = new Set(atomIds);
  // Full enclosure, in either drag direction. Crossing a bond alone does not select it.
  return { atomIds, bondIds: graph.bonds.filter(bond => ids.has(bond.from) && ids.has(bond.to)).map(bond => bond.id) };
}
export function deletionEdits(selection, graph) {
  const normalized = normalizeSelection(selection, graph), atomIds = new Set(normalized.atomIds);
  return [
    ...normalized.bondIds.filter(id => { const bond = graph.bonds.find(item => item.id === id); return !atomIds.has(bond.from) && !atomIds.has(bond.to); }).map(id => ({ type: 'deleteBond', id })),
    ...normalized.atomIds.map(id => ({ type: 'deleteAtom', id }))
  ];
}
export function selectionContext({ object = null, revision, graph, selection, edits = [], title = object?.title || '新分子', gesture = false }) {
  const local = normalizeSelection(selection, graph);
  const savedAtoms = new Set(object?.data?.atoms?.map(atom => atom.id) || []), savedBonds = new Set(object?.data?.bonds?.map(bond => bond.id) || []);
  const draft = !object || edits.length > 0 || title !== object.title || gesture;
  const draftIds = { atomIds: local.atomIds.filter(id => !savedAtoms.has(id)), bondIds: local.bondIds.filter(id => !savedBonds.has(id)) };
  const saved = !draft && !draftIds.atomIds.length && !draftIds.bondIds.length;
  return {
    schemaVersion: 1, state: saved ? 'saved' : 'draft', source: 'human-editor', saved,
    baseline: { revision, objectId: object?.id ?? null, objectVersion: object?.version ?? null },
    selection: local, draftIds, editCount: edits.length
  };
}
export function savedSelectionPayload(context) {
  if (!context.saved || context.state !== 'saved' || context.draftIds.atomIds.length || context.draftIds.bondIds.length || !context.baseline.objectId) return null;
  return { objectIds: [context.baseline.objectId], revision: context.baseline.revision, objectVersion: context.baseline.objectVersion, ...structuredClone(context.selection), state: 'saved', source: context.source };
}
export function localDraftContext(input) {
  return { ...selectionContext(input), state: 'draft', saved: false, scope: 'local-export', title: input.title,
    edits: structuredClone(input.edits), graph: structuredClone(input.graph) };
}

// Serializes publications, drops obsolete queued work and never retries a fragment on
// a newer baseline. A dirty/stale/closed editor can only clear the shared selection.
export function createSelectionPublisher({ request, onStatus = () => {} }) {
  let generation = 0, queue = Promise.resolve();
  return {
    publish(context) {
      const token = ++generation, snapshot = structuredClone(context);
      queue = queue.then(async () => {
        if (token !== generation) return;
        onStatus({ state: 'checking' });
        const { document } = await request('/api/document');
        if (token !== generation) return;
        const payload = snapshot && savedSelectionPayload(snapshot);
        const current = snapshot?.baseline.objectId ? document.objects[snapshot.baseline.objectId] : null;
        const stale = !!snapshot?.baseline.objectId && (document.revision !== snapshot.baseline.revision || current?.version !== snapshot.baseline.objectVersion);
        if (payload && !stale) {
          const receipt = await request('/api/selection', payload);
          if (token === generation) onStatus({ state: 'published', baseline: snapshot.baseline, published: receipt?.selection, document });
        } else {
          await request('/api/selection', { objectIds: [], atomIds: [], bondIds: [], revision: document.revision, state: 'saved', source: 'human-editor' });
          if (token === generation) onStatus({ state: stale ? 'stale' : snapshot ? 'local' : 'cleared' });
        }
      }).catch(error => { if (token === generation) onStatus({ state: 'error', message: error.message }); });
      return queue;
    },
    flush: () => queue,
    cancel: () => { generation++; }
  };
}
